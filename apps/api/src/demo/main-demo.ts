import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { config } from '../config';
import { seedDemoBusiness } from './demo-business';

/** `pnpm --filter @fr/api demo` — fills an empty database with a DEMO business (requires DEMO_MODE=true). */
async function main() {
  const c = config();
  if (c.NODE_ENV === 'production' || !c.DEMO_MODE) throw new Error('Set DEMO_MODE=true (never in production) to generate demo data.');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  await seedDemoBusiness(app, { days: Number(process.env.DEMO_DAYS ?? 90), ordersPerDay: Number(process.env.DEMO_ORDERS_PER_DAY ?? 8) });
  await app.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
