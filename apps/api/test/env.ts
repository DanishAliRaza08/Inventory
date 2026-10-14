import { tmpdir } from 'os';
import { join } from 'path';

export const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://fr:fr@localhost:5432/fashion_rockstar_test?schema=public',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  QUEUE_MODE: 'inline',
  AGGREGATE_CACHE_SECONDS: '0',
  DEMO_MODE: 'true',
  UPLOAD_DIR: join(tmpdir(), 'fr-test-uploads'),
  MFA_ENFORCE_FOR_PRIVILEGED: 'false',
};
Object.assign(process.env, TEST_ENV);
