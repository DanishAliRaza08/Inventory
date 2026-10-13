import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';

export type JobHandler<T = unknown> = (data: T) => Promise<void>;

export const QUEUES = {
  PUBLICATION: 'listing-publication',
  IMPORT: 'product-import',
} as const;

/**
 * Thin wrapper over BullMQ. In `inline` mode (tests, single-process dev) jobs run in-process
 * right after being enqueued, which keeps the same code path without Redis.
 * Job ids are derived from domain idempotency keys so duplicates are collapsed by the queue.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly handlers = new Map<string, JobHandler<any>>();
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];
  private connection: IORedis | null = null;
  private readonly inlinePending: Promise<void>[] = [];

  register<T>(queue: string, handler: JobHandler<T>) {
    this.handlers.set(queue, handler as JobHandler<any>);
  }

  private conn() {
    if (!this.connection) this.connection = new IORedis(config().REDIS_URL, { maxRetriesPerRequest: null });
    return this.connection;
  }

  async enqueue<T extends object>(queue: string, data: T, opts: { jobId?: string; delayMs?: number } = {}) {
    if (config().QUEUE_MODE === 'inline') {
      const handler = this.handlers.get(queue);
      if (!handler) throw new Error(`No handler registered for queue ${queue}`);
      const p = (async () => {
        if (opts.delayMs) return; // delayed retries are driven explicitly in inline mode
        await handler(data).catch((e) => this.logger.error(`Inline job on ${queue} failed: ${(e as Error).message}`));
      })();
      this.inlinePending.push(p);
      await p;
      return;
    }
    let q = this.queues.get(queue);
    if (!q) {
      q = new Queue(queue, { connection: this.conn() });
      this.queues.set(queue, q);
    }
    // Domain-level retries are handled by the handlers (they know transient vs permanent errors).
    await q.add(queue, data, { jobId: opts.jobId, delay: opts.delayMs, removeOnComplete: 1000, removeOnFail: 5000, attempts: 1 });
  }

  /** Start BullMQ workers for all registered handlers (worker process only). */
  startWorkers(concurrency = 4) {
    for (const [name, handler] of this.handlers) {
      const w = new Worker(name, async (job) => handler(job.data), { connection: this.conn(), concurrency });
      w.on('failed', (job, err) => this.logger.error(`Job ${job?.id} on ${name} failed: ${err.message}`));
      this.workers.push(w);
      this.logger.log(`Worker started for ${name}`);
    }
  }

  /** Test helper: wait for inline jobs. */
  async drain() {
    await Promise.all(this.inlinePending.splice(0));
  }

  async onModuleDestroy() {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    if (this.connection) await this.connection.quit().catch(() => undefined);
  }
}
