import 'reflect-metadata';
import { writeFileSync } from 'fs';
import { buildOpenApi, createApp } from '../src/bootstrap';

/** Writes the OpenAPI 3 document to docs/openapi.json without starting the HTTP server. */
async function main() {
  process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost:5432/unused';
  process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32).toString('base64');
  process.env.QUEUE_MODE ??= 'inline';
  const app = await createApp({ logger: false });
  const doc = buildOpenApi(app);
  writeFileSync(`${__dirname}/../../../docs/openapi.json`, JSON.stringify(doc, null, 2));
  console.log(`Wrote ${Object.keys(doc.paths).length} paths to docs/openapi.json`);
  await app.close();
}

void main();
