import { PrismaClient } from '@prisma/client';
import { seedBase, seedDemo, upsertUser } from '../src/seed';

async function main() {
  const prisma = new PrismaClient();
  await seedBase(prisma);
  const email = process.env.SEED_OWNER_EMAIL;
  const password = process.env.SEED_OWNER_PASSWORD;
  if (email && password) {
    await upsertUser(prisma, email.toLowerCase(), process.env.SEED_OWNER_NAME ?? 'Owner', password, ['owner']);
    console.log(`Owner account ready: ${email}`);
  } else {
    console.log('Set SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD to create the first owner account.');
  }
  if (process.env.DEMO_MODE === 'true') {
    if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production.');
    await seedDemo(prisma);
    console.log('Demo data seeded (clearly labelled DEMO; demo accounts never contact marketplaces).');
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
