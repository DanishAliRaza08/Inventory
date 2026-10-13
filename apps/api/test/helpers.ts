import './env';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createApp } from '../src/bootstrap';
import { resetConfigCache } from '../src/config';
import { seedBase, seedDemo, upsertUser } from '../src/seed';

export const PASSWORD = 'Test-Password-2026';

export async function resetDb(prisma: PrismaClient) {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

export interface TestContext {
  app: INestApplication;
  prisma: PrismaClient;
  /** Logged-in agents per role. */
  as: (role: string) => Promise<Agent>;
  close: () => Promise<void>;
}

export type Agent = ReturnType<typeof makeAgent>;

function makeAgent(app: INestApplication, cookie: string) {
  const server = app.getHttpServer();
  const wrap = (r: request.Test) => r.set('Cookie', cookie).set('X-Requested-With', 'fr-test');
  return {
    cookie,
    get: (url: string) => wrap(request(server).get(url)),
    post: (url: string, body?: object) => wrap(request(server).post(url)).send(body ?? {}),
    patch: (url: string, body?: object) => wrap(request(server).patch(url)).send(body ?? {}),
    put: (url: string, body?: object) => wrap(request(server).put(url)).send(body ?? {}),
    delete: (url: string) => wrap(request(server).delete(url)),
    upload: (url: string, field: string, buf: Buffer, name: string) => wrap(request(server).post(url)).attach(field, buf, name),
  };
}

export async function login(app: INestApplication, email: string, password = PASSWORD) {
  const res = await request(app.getHttpServer()).post('/api/auth/login').set('X-Requested-With', 'fr-test').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('fr_session='))!.split(';')[0]!;
  return makeAgent(app, cookie);
}

export async function setupApp(opts: { demo?: boolean } = {}): Promise<TestContext> {
  resetConfigCache();
  const prisma = new PrismaClient();
  await resetDb(prisma);
  await seedBase(prisma);
  if (opts.demo !== false) await seedDemo(prisma);
  const roles = ['owner', 'inventory_manager', 'listing_manager', 'listing_approver', 'order_manager', 'finance_manager', 'viewer'];
  for (const r of roles) await upsertUser(prisma, `${r}@test.local`, r, PASSWORD, [r]);
  const app = await createApp({ logger: false });
  await app.init();
  const agents = new Map<string, Agent>();
  return {
    app,
    prisma,
    as: async (role) => {
      if (!agents.has(role)) agents.set(role, await login(app, `${role}@test.local`));
      return agents.get(role)!;
    },
    close: async () => {
      await app.close();
      await prisma.$disconnect();
    },
  };
}

export async function createProduct(agent: Agent, over: Record<string, unknown> = {}) {
  const res = await agent.post('/api/products', {
    title: 'Test Floral Midi Dress',
    description: 'A floral midi dress.',
    category: 'Dresses',
    status: 'ACTIVE',
    fulfilmentModel: 'DROPSHIP',
    variants: [{ sku: `T-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, size: '12', colour: 'Blue', initialCost: { currency: 'GBP', supplierPrice: '8.00', supplierShipping: '2.00' } }],
    ...over,
  });
  if (res.status !== 201) throw new Error(`createProduct failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
