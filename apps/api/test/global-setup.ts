import { execSync } from 'child_process';
import { TEST_ENV } from './env';

export default function setup() {
  execSync('npx prisma migrate deploy', { env: { ...process.env, ...TEST_ENV }, stdio: 'pipe' });
}
