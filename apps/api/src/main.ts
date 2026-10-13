import 'reflect-metadata';
import { SwaggerModule } from '@nestjs/swagger';
import { buildOpenApi, createApp } from './bootstrap';
import { config } from './config';

async function main() {
  const app = await createApp();
  if (config().NODE_ENV !== 'production') SwaggerModule.setup('api/docs', app, buildOpenApi(app));
  await app.listen(config().PORT);
  // eslint-disable-next-line no-console
  console.log(`API listening on :${config().PORT} (demo mode: ${config().DEMO_MODE}, queue: ${config().QUEUE_MODE})`);
}

void main();
