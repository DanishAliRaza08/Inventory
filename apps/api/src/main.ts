import 'reflect-metadata';
import cluster from 'node:cluster';
import { SwaggerModule } from '@nestjs/swagger';
import { buildOpenApi, createApp } from './bootstrap';
import { config } from './config';

async function serve() {
  const app = await createApp();
  if (config().NODE_ENV !== 'production') SwaggerModule.setup('api/docs', app, buildOpenApi(app));
  await app.listen(config().PORT);
  // eslint-disable-next-line no-console
  console.log(`API listening on :${config().PORT} (pid ${process.pid}, demo mode: ${config().DEMO_MODE}, queue: ${config().QUEUE_MODE})`);
}

/**
 * API_WORKERS > 1 runs that many API processes sharing the port (one per CPU core is typical).
 * Each request is handled by one process, so CPU-heavy pages don't queue behind each other.
 */
const workers = config().API_WORKERS;
if (workers > 1 && cluster.isPrimary) {
  for (let i = 0; i < workers; i++) cluster.fork();
  cluster.on('exit', (w, code, signal) => {
    // eslint-disable-next-line no-console
    console.error(`API worker ${w.process.pid} exited (${signal ?? code}); starting a replacement.`);
    cluster.fork();
  });
} else {
  void serve();
}
