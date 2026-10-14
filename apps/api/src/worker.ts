import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { PublicationService } from './listings/publication.service';
import { CustomerPiiService } from './privacy/customer-pii.service';
import { QueueService } from './queue/queue.service';

/** Background worker process: runs queue consumers and periodic sweeps. */
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  app.enableShutdownHooks();
  app.get(QueueService).startWorkers();
  const publication = app.get(PublicationService);
  setInterval(() => void publication.sweep().catch(() => undefined), 60_000);
  // Personal-data retention (Amazon: ≤ 30 days after delivery).
  const pii = app.get(CustomerPiiService);
  const purge = () => void pii.purgeExpired().catch(() => undefined);
  purge();
  setInterval(purge, 60 * 60_000);
}

void main();
