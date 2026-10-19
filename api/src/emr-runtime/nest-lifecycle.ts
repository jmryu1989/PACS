import type { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import type { Module } from '@nestjs/core/injector/module';
import { getNonTransientInstances, getTransientInstances } from '@nestjs/core/injector/helpers/transient-instances';
import { refuse } from '../emr-contract/validation';

type Hook = 'onModuleInit' | 'onApplicationBootstrap' | 'onModuleDestroy' | 'beforeApplicationShutdown' | 'onApplicationShutdown';
type Stage = Hook | 'dispose';
type Status = 'not-started' | 'running' | 'fulfilled' | 'rejected';
type Instance = object & Partial<Record<Hook, (signal?: string) => unknown>>;
interface ProviderResult { status: Status; error?: unknown }
interface StageResult extends ProviderResult { providers: ProviderResult[] }
const stages: readonly Stage[] = ['onModuleInit', 'onApplicationBootstrap', 'onModuleDestroy', 'beforeApplicationShutdown', 'dispose', 'onApplicationShutdown'];

/** Nest 10.4.22 compatibility boundary: its static-tree eligibility and descending-distance ordering.
 * Nest's default fail-fast runner cannot establish that a rejected stage has finished acquiring/releasing resources.
 * Keep this adapter local to the owned application; never patch Nest or Promise globally.
 */
export function createNestLifecycle(app: INestApplication, stopSignal: AbortSignal) {
  const stageRuns = new Map<Stage, Promise<StageResult>>();
  const providerRuns = new WeakMap<Instance, Map<Stage, Promise<ProviderResult>>>();
  const accounts = new Map<Stage, StageResult>(stages.map(stage => [stage, { status: 'not-started', providers: [] }]));
  let expired = false, outerClose: Promise<void> | undefined;

  function collectHookGroups(hook: Hook): Instance[][] {
    const modules = [...app.get<ModulesContainer>(ModulesContainer).values()].sort((a: Module, b: Module) => b.distance - a.distance);
    const groups: Instance[][] = [];
    const eligible = (instance: Instance) => instance && typeof instance[hook] === 'function';
    for (const module of modules) {
      const providers = module.getNonAliasProviders();
      const [, moduleHost] = providers.shift();
      const instances = [...module.controllers, ...providers, ...module.injectables, ...module.middlewares];
      // The pinned helper declarations say InstanceWrapper[], but their runtime maps wrappers to actual instances.
      groups.push((getNonTransientInstances(instances) as unknown as Instance[]).filter(eligible),
        (getTransientInstances(instances) as unknown as Instance[]).filter(eligible));
      const moduleInstance = moduleHost.instance as Instance;
      groups.push(moduleHost.isDependencyTreeStatic() && eligible(moduleInstance) ? [moduleInstance] : []);
    }
    return groups;
  }

  function invokeOnce(instance: Instance, stage: Stage, invoke: () => unknown, account: ProviderResult): Promise<ProviderResult> {
    let runs = providerRuns.get(instance);
    if (!runs) { runs = new Map(); providerRuns.set(instance, runs); }
    const previous = runs.get(stage);
    if (previous) return previous;
    const result = Promise.resolve().then(async () => {
      account.status = 'running';
      try { await invoke(); account.status = 'fulfilled'; }
      catch (error) { account.status = 'rejected'; account.error = error; }
      return account;
    });
    runs.set(stage, result);
    return result;
  }

  function runStage(stage: Stage, signal?: string): Promise<StageResult> {
    const previous = stageRuns.get(stage);
    if (previous) return previous;
    const result = Promise.resolve().then(async () => {
      const account = accounts.get(stage)!;
      if (expired) return account;
      const initializing = stage === 'onModuleInit' || stage === 'onApplicationBootstrap';
      if (initializing && stopSignal.aborted) refuse('EmrStartupInterrupted');
      account.status = 'running';
      const groups = stage === 'dispose' ? [[app.getHttpAdapter()]] : collectHookGroups(stage);
      const planned = groups.map(group => group.map(instance => {
        const provider: ProviderResult = { status: 'not-started' };
        account.providers.push(provider);
        return { instance, provider };
      }));
      for (const group of planned) {
        if (expired) return account;
        if (initializing && stopSignal.aborted) refuse('EmrStartupInterrupted');
        const settled = await Promise.allSettled(group.map(({ instance, provider }) => invokeOnce(instance, stage,
          () => stage === 'dispose' ? app.getHttpAdapter().close() : instance[stage](signal), provider)));
        for (let i = 0; i < settled.length; i++) {
          const value = settled[i];
          if (value.status === 'fulfilled') Object.assign(group[i].provider, value.value);
          else Object.assign(group[i].provider, { status: 'rejected', error: value.reason });
        }
      }
      account.status = account.providers.some(provider => provider.status === 'rejected') ? 'rejected' : 'fulfilled';
      return account;
    });
    stageRuns.set(stage, result);
    return result;
  }

  function installInitializationBarrier() {
    // NestFactory's set proxy wraps assignments; own descriptors replace the actual dispatch seams.
    for (const [method, stage] of [['callInitHook', 'onModuleInit'], ['callBootstrapHook', 'onApplicationBootstrap']] as const) {
      Object.defineProperty(app, method, { configurable: true, value: async () => {
        const result = await runStage(stage);
        if (result.status !== 'fulfilled') throw new AggregateError(result.providers.filter(p => p.status === 'rejected').map(p => p.error), 'EmrInitializationFailed');
        if (stopSignal.aborted) refuse('EmrStartupInterrupted');
      } });
    }
  }
  installInitializationBarrier();
  return Object.freeze({
    verifyOwnership() {
      if (app.getMicroservices().length) refuse('EmrTransportOwnershipRefused');
    },
    close(signal?: string): Promise<void> {
      return outerClose ??= Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        for (const stage of ['onModuleDestroy', 'beforeApplicationShutdown', 'dispose', 'onApplicationShutdown'] as const) {
          if (expired) break;
          try {
            const result = await runStage(stage, signal);
            failures.push(...result.providers.filter(provider => provider.status === 'rejected').map(provider => provider.error));
          } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, 'EmrApplicationCleanupFailed');
      });
    },
    expire() { expired = true; },
    accounting() {
      return stages.map(stage => ({ stage, status: accounts.get(stage)!.status,
        providers: accounts.get(stage)!.providers.map(provider => provider.status) }));
    },
  });
}
