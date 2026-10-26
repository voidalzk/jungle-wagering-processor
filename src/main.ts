import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createDatabase } from './persistence/database';
import { WageringService } from './application/wagering';
import { ApiController, HealthController } from './http/controller';
import { ErrorFilter } from './http/error.filter';
import { Queues } from './messaging/sqs';
import { Workers } from './messaging/workers';
import { config } from './config';
import { log } from './observability';

async function main() {
  const db = await createDatabase().initialize();
  const service = new WageringService(db);
  const queues = new Queues();
  const workers = new Workers(service, queues);
  @Module({
    controllers: [ApiController, HealthController],
    providers: [
      { provide: WageringService, useValue: service },
      { provide: Queues, useValue: queues },
    ],
  })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new ErrorFilter());
  await app.listen(config.port, '0.0.0.0');
  if (config.workers) workers.start();
  log('info', 'application_started');
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    const closed = app.close();
    await workers.stop();
    await closed;
    queues.close();
    await db.destroy();
  }
  process.on('SIGTERM', () => {
    void shutdown().catch(() => process.exit(1));
  });
  process.on('SIGINT', () => {
    void shutdown().catch(() => process.exit(1));
  });
}
main().catch(() => {
  log('error', 'startup_failed', { code: 'INFRASTRUCTURE_UNAVAILABLE' });
  process.exitCode = 1;
});
