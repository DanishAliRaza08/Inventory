import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { config } from './config';

export async function createApp(opts: { logger?: boolean } = {}): Promise<INestApplication> {
  const cfg = config();
  const app = await NestFactory.create(AppModule, { logger: opts.logger === false ? false : ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: cfg.WEB_ORIGIN, credentials: true, allowedHeaders: ['Content-Type', 'X-Requested-With'] });
  (app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set('trust proxy', 1);
  app.enableShutdownHooks();
  return app;
}

export function buildOpenApi(app: INestApplication) {
  const doc = new DocumentBuilder()
    .setTitle('Fashion Rockstar Operations API')
    .setDescription(
      'Multi-channel inventory, profit and listing management. All state-changing requests require the X-Requested-With header and a session cookie (fr_session).',
    )
    .setVersion('0.1.0')
    .addCookieAuth('fr_session')
    .build();
  return SwaggerModule.createDocument(app, doc);
}
