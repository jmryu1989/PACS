import type { BeforeApplicationShutdown, OnApplicationShutdown } from '@nestjs/common';
import type { EmrRuntime } from './application';

// Existing v4 drain (10s) + cleanup (5s) allowance, now one shared deadline.
const SHUTDOWN_MS = 15000;
export class EmrNestLifecycle implements BeforeApplicationShutdown, OnApplicationShutdown {
  private deadline: number | undefined;
  constructor(private readonly runtime: EmrRuntime) {}
  beforeApplicationShutdown(): void {
    this.deadline ??= Date.now() + SHUTDOWN_MS;
    this.runtime.control.close();
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
