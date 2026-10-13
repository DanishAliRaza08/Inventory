import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import IORedis from 'ioredis';
import { Public } from '../auth/decorators';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Public()
  async health() {
    const checks: Record<string, string> = {};
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch {
      checks.database = 'down';
    }
    if (config().QUEUE_MODE === 'bullmq') {
      const r = new IORedis(config().REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2000 });
      try {
        await r.connect();
        checks.redis = (await r.ping()) === 'PONG' ? 'ok' : 'down';
      } catch {
        checks.redis = 'down';
      } finally {
        r.disconnect();
      }
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    if (!ok) throw new ServiceUnavailableException({ status: 'degraded', checks });
    return { status: 'ok', checks, demoMode: config().DEMO_MODE, environment: config().NODE_ENV };
  }
}
