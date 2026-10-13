import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /** inline = run background jobs in-process (tests); bullmq = Redis-backed queue. */
  QUEUE_MODE: z.enum(['inline', 'bullmq']).default('bullmq'),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  /** 32-byte key, base64. Encrypts marketplace credentials and MFA secrets. */
  APP_ENCRYPTION_KEY: z.string().min(1),
  SESSION_IDLE_MINUTES: z.coerce.number().default(120),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().default(12),
  MFA_ENFORCE_FOR_PRIVILEGED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Demonstration mode enables the clearly-labelled DEMO marketplace connector and sample
   * data. It can never be enabled in production.
   */
  DEMO_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  UPLOAD_DIR: z.string().default('./uploads'),
  REPORTING_CURRENCY: z.string().length(3).default('GBP'),
});

export type AppConfig = z.infer<typeof EnvSchema>;

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${parsed.error.issues.map((i) => ` - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && cfg.DEMO_MODE) throw new Error('DEMO_MODE cannot be enabled in production.');
  if (Buffer.from(cfg.APP_ENCRYPTION_KEY, 'base64').length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded.');
  return cfg;
}

export function config(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

export function resetConfigCache() {
  cached = null;
}
