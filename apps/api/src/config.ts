import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  /** API processes sharing the port (Node cluster). One per CPU core is typical in production. */
  API_WORKERS: z.coerce.number().int().min(1).max(64).default(1),
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
  /** Public URL of the API (OAuth redirects, signed image links marketplaces download). */
  PUBLIC_BASE_URL: z.string().default('http://localhost:4000'),

  /**
   * Route every marketplace / supplier connector to the local mock server (dummy data).
   * Never allowed in production. Run it with `pnpm --filter @fr/api mock`.
   */
  MOCK_MARKETPLACES: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  MOCK_BASE_URL: z.string().default('http://localhost:4100'),

  // ── eBay (UK + US share one developer app) ──
  EBAY_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  EBAY_CLIENT_ID: z.string().default(''),
  EBAY_CLIENT_SECRET: z.string().default(''),
  /** eBay "RuName" (redirect URL name) configured in the developer portal. */
  EBAY_RU_NAME: z.string().default(''),
  /** Digital-signature keys (Key Management API) for Finances API calls by UK/EU sellers. */
  EBAY_SIGNING_KEY_JWE: z.string().default(''),
  EBAY_SIGNING_PRIVATE_KEY: z.string().default(''),

  // ── Amazon Selling Partner API ──
  AMAZON_LWA_CLIENT_ID: z.string().default(''),
  AMAZON_LWA_CLIENT_SECRET: z.string().default(''),
  AMAZON_SP_APP_ID: z.string().default(''),

  // ── TikTok Shop ──
  TIKTOK_APP_KEY: z.string().default(''),
  TIKTOK_APP_SECRET: z.string().default(''),
  TIKTOK_SERVICE_ID: z.string().default(''),

  // ── Suppliers ──
  ALIEXPRESS_APP_KEY: z.string().default(''),
  ALIEXPRESS_APP_SECRET: z.string().default(''),
  CJ_API_KEY: z.string().default(''),

  // ── AI listing assistant (Claude) ──
  ANTHROPIC_API_KEY: z.string().default(''),
  AI_MODEL: z.string().default('claude-opus-5-5'),

  /** Seconds dashboard and report aggregates are cached in-process (0 disables). */
  AGGREGATE_CACHE_SECONDS: z.coerce.number().min(0).default(60),

  /** Background schedules (minutes). */
  SYNC_ORDERS_EVERY_MIN: z.coerce.number().default(10),
  SYNC_FINANCE_EVERY_MIN: z.coerce.number().default(60),
  SYNC_INVENTORY_EVERY_MIN: z.coerce.number().default(15),
  SYNC_SUPPLIERS_EVERY_MIN: z.coerce.number().default(360),
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
  if (cfg.NODE_ENV === 'production' && cfg.MOCK_MARKETPLACES) throw new Error('MOCK_MARKETPLACES cannot be enabled in production.');
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

/** Base URLs for every external API; all point at the mock server when MOCK_MARKETPLACES=true. */
export function endpoints() {
  const c = config();
  const m = (path: string) => `${c.MOCK_BASE_URL}${path}`;
  const sandbox = c.EBAY_ENV === 'sandbox';
  if (c.MOCK_MARKETPLACES) {
    return {
      ebayAuthorize: m('/ebay/oauth2/authorize'), ebayToken: m('/ebay/identity/v1/oauth2/token'), ebayApi: m('/ebay'), ebayApiz: m('/ebay'), ebayTrading: m('/ebay/ws/api.dll'),
      amazonConsent: m('/amazon/apps/authorize/consent'), amazonToken: m('/amazon/auth/o2/token'), amazonApi: m('/amazon'),
      tiktokAuthorize: m('/tiktok/open/authorize'), tiktokAuth: m('/tiktok/auth'), tiktokApi: m('/tiktok/api'),
      aliexpressAuthorize: m('/aliexpress/oauth/authorize'), aliexpressApi: m('/aliexpress/rest'), aliexpressSync: m('/aliexpress/sync'),
      cjApi: m('/cj/api2.0/v1'),
    };
  }
  return {
    ebayAuthorize: sandbox ? 'https://auth.sandbox.ebay.com/oauth2/authorize' : 'https://auth.ebay.com/oauth2/authorize',
    ebayToken: sandbox ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token' : 'https://api.ebay.com/identity/v1/oauth2/token',
    ebayApi: sandbox ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com',
    ebayApiz: sandbox ? 'https://apiz.sandbox.ebay.com' : 'https://apiz.ebay.com',
    ebayTrading: sandbox ? 'https://api.sandbox.ebay.com/ws/api.dll' : 'https://api.ebay.com/ws/api.dll',
    amazonConsent: 'https://sellercentral.amazon.co.uk/apps/authorize/consent',
    amazonToken: 'https://api.amazon.com/auth/o2/token',
    amazonApi: 'https://sellingpartnerapi-eu.amazon.com',
    tiktokAuthorize: 'https://services.tiktokshop.com/open/authorize',
    tiktokAuth: 'https://auth.tiktok-shops.com',
    tiktokApi: 'https://open-api.tiktokglobalshop.com',
    aliexpressAuthorize: 'https://api-sg.aliexpress.com/oauth/authorize',
    aliexpressApi: 'https://api-sg.aliexpress.com/rest',
    aliexpressSync: 'https://api-sg.aliexpress.com/sync',
    cjApi: 'https://developers.cjdropshipping.com/api2.0/v1',
  };
}

/** Credentials, falling back to obvious dummy values in mock mode. */
export function appCredentials() {
  const c = config();
  const mock = (v: string, d: string) => v || (c.MOCK_MARKETPLACES ? d : '');
  return {
    ebay: { clientId: mock(c.EBAY_CLIENT_ID, 'mock-ebay-client'), clientSecret: mock(c.EBAY_CLIENT_SECRET, 'mock-ebay-secret'), ruName: mock(c.EBAY_RU_NAME, 'mock-runame') },
    amazon: { clientId: mock(c.AMAZON_LWA_CLIENT_ID, 'mock-lwa-client'), clientSecret: mock(c.AMAZON_LWA_CLIENT_SECRET, 'mock-lwa-secret'), appId: mock(c.AMAZON_SP_APP_ID, 'mock-sp-app') },
    tiktok: { appKey: mock(c.TIKTOK_APP_KEY, 'mock-tiktok-key'), appSecret: mock(c.TIKTOK_APP_SECRET, 'mock-tiktok-secret'), serviceId: mock(c.TIKTOK_SERVICE_ID, 'mock-service') },
    aliexpress: { appKey: mock(c.ALIEXPRESS_APP_KEY, 'mock-ae-key'), appSecret: mock(c.ALIEXPRESS_APP_SECRET, 'mock-ae-secret') },
    cj: { apiKey: mock(c.CJ_API_KEY, 'mock-cj-key') },
  };
}
