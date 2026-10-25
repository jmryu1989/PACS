import type { BeforeApplicationShutdown, OnApplicationShutdown, OnModuleDestroy } from '@nestjs/common';
import type { EmrRuntime } from './application';

// Existing v4 drain (10s) + cleanup (5s) allowance, now one shared deadline.
const SHUTDOWN_MS = 15000;
export class EmrNestLifecycle implements BeforeApplicationShutdown, OnApplicationShutdown, OnModuleDestroy {
  private deadline: number | undefined;
  constructor(private readonly runtime: EmrRuntime) {}
  onModuleDestroy(): void {
    this.deadline ??= Date.now() + SHUTDOWN_MS;
    this.runtime.background.quiesce();
  }
  async beforeApplicationShutdown(): Promise<void> {
    this.deadline ??= Date.now() + SHUTDOWN_MS;
    this.runtime.control.close();
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([this.runtime.background.drained(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('EmrBackgroundShutdownDeadline')), Math.max(0, this.deadline! - Date.now()));
      })]);
    } catch (error) { process.exitCode = 1; throw error; }
    finally { clearTimeout(timer); }
  }
  async onApplicationShutdown(): Promise<void> {
    this.deadline ??= Date.now() + SHUTDOWN_MS;
    try { await this.runtime.stop(this.deadline); }
    catch (error) {
      process.exitCode = 1;
      console.error('[EMR] Shutdown did not complete cleanly.');
      throw error;
    }
  }
}
