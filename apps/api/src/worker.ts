import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { PublicationService } from './listings/publication.service';
import { QueueService } from './queue/queue.service';

/** Background worker process: runs queue consumers and periodic sweeps. */
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  app.enableShutdownHooks();
  app.get(QueueService).startWorkers();
  const publication = app.get(PublicationService);
  setInterval(() => void publication.sweep().catch(() => undefined), 60_000);
}

void main();
