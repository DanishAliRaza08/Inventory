import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { CryptoService } from './common/crypto.service';
import { config } from './config';
import { AllExceptionsFilter } from './common/errors.filter';
import { SerializeInterceptor } from './common/serialize.interceptor';
import { CostsController } from './costs/costs.controller';
import { CostsService } from './costs/costs.service';
import { DashboardController } from './dashboard/dashboard.controller';
import { DashboardService } from './dashboard/dashboard.service';
import { FinanceController } from './finance/finance.controller';
import { ProfitService } from './finance/profit.service';
import { HealthController } from './health/health.controller';
import { ImportsController } from './imports/imports.controller';
import { ImportsService } from './imports/imports.service';
import { AccountsController } from './integrations/accounts.controller';
import { ConnectorRegistry } from './integrations/connector-registry';
import { InventoryController } from './inventory/inventory.controller';
import { InventoryService } from './inventory/inventory.service';
import { ListingsController } from './listings/listings.controller';
import { ListingsService } from './listings/listings.service';
import { PublicationService } from './listings/publication.service';
import { NotificationsController, NotificationsService } from './notifications/notifications.service';
import { PrismaModule } from './prisma/prisma.module';
import { CustomerPiiController, CustomerPiiService } from './privacy/customer-pii.service';
import { ImagesController } from './products/images.controller';
import { ProductsController } from './products/products.controller';
import { ProductsService } from './products/products.service';
import { QueueModule } from './queue/queue.module';
import { SettingsController } from './settings/settings.controller';
import { SettingsService } from './settings/settings.service';
import { StorageService } from './storage/storage.service';
import { SuppliersController } from './suppliers/suppliers.controller';
import { SuppliersService } from './suppliers/suppliers.service';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

/**
 * Modular monolith: each folder is a bounded module (catalogue, suppliers/costs, inventory,
 * finance, listings, integrations, imports). Marketplace connectors are isolated behind the
 * ConnectorRegistry so one connector can change without touching the rest.
 */
@Module({
  imports: [PrismaModule, QueueModule, ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 600 }], skipIf: () => config().NODE_ENV === 'test' })],
  controllers: [
    HealthController, AuthController, UsersController, AuditController, SettingsController, NotificationsController,
    ProductsController, ImagesController, SuppliersController, CostsController, InventoryController,
    FinanceController, ListingsController, AccountsController, ImportsController, DashboardController, CustomerPiiController,
  ],
  providers: [
    CryptoService, AuditService, AuthService, SettingsService, NotificationsService, UsersService, StorageService,
    ProductsService, SuppliersService, CostsService, InventoryService, ProfitService,
    ListingsService, PublicationService, ConnectorRegistry, ImportsService, DashboardService, CustomerPiiService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: SerializeInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
