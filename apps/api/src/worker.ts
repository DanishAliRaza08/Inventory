import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AiAssistantService } from './ai/ai-assistant.service';
import { AppModule } from './app.module';
import { AutomationService } from './automation/automation.service';
import { config } from './config';
import { SyncService } from './integrations/sync.service';
import { InventorySyncService } from './inventory/inventory-sync.service';
import { PublicationService } from './listings/publication.service';
import { CustomerPiiService } from './privacy/customer-pii.service';
import { QueueService } from './queue/queue.service';
import { SupplierSyncService } from './suppliers/supplier-sync.service';

const log = new Logger('Worker');

/** Runs `task` every `minutes`, never overlapping itself; errors are logged, not fatal. */
function every(name: string, minutes: number, task: () => Promise<unknown>, runNow = true) {
  if (minutes <= 0) return log.log(`${name}: disabled`);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await task();
    } catch (e) {
      log.error(`${name} failed: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  if (runNow) void tick();
  setInterval(() => void tick(), minutes * 60_000);
  log.log(`${name}: every ${minutes} min`);
}

/** Background worker process: queue consumers plus the periodic sync / automation schedule. */
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  app.enableShutdownHooks();
  app.get(QueueService).startWorkers();
  const c = config();
  const sync = app.get(SyncService);
  const suppliers = app.get(SupplierSyncService);

  every('Publication sweep', 1, () => app.get(PublicationService).sweep());
  every('Order sync', c.SYNC_ORDERS_EVERY_MIN, () => sync.syncAllOrders());
  every('Finance sync', c.SYNC_FINANCE_EVERY_MIN, () => sync.syncAllFinance());
  every('Inventory push', c.SYNC_INVENTORY_EVERY_MIN, () => app.get(InventorySyncService).syncAll());
  every('Supplier price/stock sync', c.SYNC_SUPPLIERS_EVERY_MIN, () => suppliers.syncAll());
  every('Supplier tracking poll', 30, () => suppliers.pollTracking());
  every('Automation rules', 5, () => app.get(AutomationService).runDue());
  every('Image checks (AI)', 30, () => app.get(AiAssistantService).checkPendingImages());
  // Personal-data retention (Amazon: ≤ 30 days after delivery).
  every('Customer data purge', 60, () => app.get(CustomerPiiService).purgeExpired());
}

void main();
