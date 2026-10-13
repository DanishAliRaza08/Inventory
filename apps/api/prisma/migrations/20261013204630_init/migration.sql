-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DISCONTINUED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "FulfilmentModel" AS ENUM ('PHYSICAL', 'DROPSHIP');

-- CreateEnum
CREATE TYPE "SkuAliasType" AS ENUM ('MARKETPLACE', 'SUPPLIER', 'LEGACY');

-- CreateEnum
CREATE TYPE "SupplierType" AS ENUM ('ALIEXPRESS', 'CJ_DROPSHIPPING', 'MANUAL', 'OTHER');

-- CreateEnum
CREATE TYPE "SupplierStockStatus" AS ENUM ('IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'UNKNOWN', 'DISCONTINUED');

-- CreateEnum
CREATE TYPE "InventoryPolicy" AS ENUM ('MANUAL', 'SUPPLIER_MONITOR', 'AUTO_SYNC', 'AUTO_PAUSE');

-- CreateEnum
CREATE TYPE "AllocationMode" AS ENUM ('SHARED', 'FIXED', 'PERCENTAGE');

-- CreateEnum
CREATE TYPE "StockBucket" AS ENUM ('AVAILABLE', 'RESERVED', 'COMMITTED', 'DAMAGED', 'RETURNED', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "Marketplace" AS ENUM ('EBAY_UK', 'EBAY_US', 'AMAZON_UK', 'TIKTOK_UK');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('NOT_CONNECTED', 'CONNECTED', 'EXPIRED', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "ApiEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION', 'DEMO');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('INCOMPLETE', 'DRAFT', 'VALIDATION_FAILED', 'AWAITING_APPROVAL', 'APPROVED', 'PUBLISHING', 'ACTIVE', 'PUBLICATION_FAILED', 'PAUSED', 'ENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('UPLOADED', 'VALIDATED', 'IMPORTING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "mfa_secret_enc" TEXT,
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "requires_mfa" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_key" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_key")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "mfa_verified" BOOLEAN NOT NULL DEFAULT false,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "product_number" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "category" TEXT,
    "brand" TEXT,
    "country_of_origin" TEXT,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "fulfilment_model" "FulfilmentModel" NOT NULL DEFAULT 'DROPSHIP',
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "title" TEXT,
    "size" TEXT,
    "colour" TEXT,
    "material" TEXT,
    "barcode" TEXT,
    "weight_grams" INTEGER,
    "length_mm" INTEGER,
    "width_mm" INTEGER,
    "height_mm" INTEGER,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sku_aliases" (
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "type" "SkuAliasType" NOT NULL,
    "scope" TEXT NOT NULL DEFAULT '',
    "alias" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sku_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_images" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "storage_key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_main" BOOLEAN NOT NULL DEFAULT false,
    "width" INTEGER,
    "height" INTEGER,
    "format" TEXT,
    "size_bytes" INTEGER,
    "sha256" TEXT,
    "alt_text" TEXT,
    "source" TEXT NOT NULL DEFAULT 'UPLOAD',
    "approved" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "SupplierType" NOT NULL DEFAULT 'MANUAL',
    "website" TEXT,
    "contact_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "default_currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "processing_days" INTEGER,
    "delivery_days_min" INTEGER,
    "delivery_days_max" INTEGER,
    "reliability_notes" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_products" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "supplier_sku" TEXT,
    "supplier_product_id" TEXT,
    "url" TEXT,
    "current_price" DECIMAL(14,4) NOT NULL,
    "shipping_cost" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "processing_days" INTEGER,
    "delivery_days_min" INTEGER,
    "delivery_days_max" INTEGER,
    "stock_status" "SupplierStockStatus" NOT NULL DEFAULT 'UNKNOWN',
    "reported_quantity" INTEGER,
    "stock_checked_at" TIMESTAMP(3),
    "stock_source" TEXT,
    "manually_verified_at" TIMESTAMP(3),
    "manually_verified_by" UUID,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "last_price_update_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_price_history" (
    "id" UUID NOT NULL,
    "supplier_product_id" UUID NOT NULL,
    "price" DECIMAL(14,4) NOT NULL,
    "shipping_cost" DECIMAL(14,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "recorded_by_id" UUID,

    CONSTRAINT "supplier_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_records" (
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "effective_to" TIMESTAMP(3),
    "currency" CHAR(3) NOT NULL,
    "supplier_price" DECIMAL(14,4) NOT NULL,
    "supplier_shipping" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "packaging" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "import_duty" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "non_recoverable_tax" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "fx_conversion_percent" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "purchase_payment_percent" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "other_per_unit" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "notes" TEXT,
    "verified_at" TIMESTAMP(3),
    "verified_by_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_records" (
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "location" TEXT NOT NULL DEFAULT 'MAIN',
    "available" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "committed" INTEGER NOT NULL DEFAULT 0,
    "damaged" INTEGER NOT NULL DEFAULT 0,
    "returned" INTEGER NOT NULL DEFAULT 0,
    "safety_stock" INTEGER NOT NULL DEFAULT 0,
    "policy" "InventoryPolicy" NOT NULL DEFAULT 'MANUAL',
    "allocation_mode" "AllocationMode" NOT NULL DEFAULT 'SHARED',
    "require_relist_approval" BOOLEAN NOT NULL DEFAULT true,
    "dropship_settings" JSONB,
    "last_checked_at" TIMESTAMP(3),
    "source" TEXT,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" UUID NOT NULL,
    "inventory_record_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "from_bucket" "StockBucket" NOT NULL,
    "to_bucket" "StockBucket" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT,
    "idempotency_key" TEXT,
    "order_line_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_accounts" (
    "id" UUID NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "name" TEXT NOT NULL,
    "environment" "ApiEnvironment" NOT NULL DEFAULT 'SANDBOX',
    "external_account_id" TEXT,
    "status" "AccountStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "connected_at" TIMESTAMP(3),
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_credentials" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "auth_tag" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "scopes" TEXT[],
    "access_token_expires_at" TIMESTAMP(3),
    "refresh_token_expires_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_states" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "resource" TEXT NOT NULL,
    "cursor" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "last_success_at" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,

    CONSTRAINT "sync_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_listings" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "status" "ListingStatus" NOT NULL DEFAULT 'INCOMPLETE',
    "sku" TEXT NOT NULL,
    "external_listing_id" TEXT,
    "external_offer_id" TEXT,
    "price" DECIMAL(14,4),
    "currency" CHAR(3) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "allocation" INTEGER,
    "auto_paused" BOOLEAN NOT NULL DEFAULT false,
    "current_version_id" UUID,
    "published_version_id" UUID,
    "last_published_at" TIMESTAMP(3),
    "last_error" TEXT,
    "assigned_to_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_versions" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_by_id" UUID,
    "submitted_at" TIMESTAMP(3),
    "approved_by_id" UUID,
    "approved_at" TIMESTAMP(3),
    "rejected_by_id" UUID,
    "rejected_at" TIMESTAMP(3),
    "review_note" TEXT,

    CONSTRAINT "listing_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_validation_results" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "valid" BOOLEAN NOT NULL,
    "complete" BOOLEAN NOT NULL,
    "blocking_count" INTEGER NOT NULL,
    "issues" JSONB NOT NULL,
    "ran_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_validation_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_status_history" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "from_status" "ListingStatus" NOT NULL,
    "to_status" "ListingStatus" NOT NULL,
    "event" TEXT NOT NULL,
    "actor_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_publication_jobs" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "batch_id" UUID,
    "operation" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "idempotency_key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_attempt_at" TIMESTAMP(3),
    "requested_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "listing_publication_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_operations" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "job_id" UUID,
    "status" TEXT NOT NULL,
    "error_code" TEXT,
    "error_message" TEXT,
    "readable_error" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "next_action" TEXT,
    "http_status" INTEGER,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "order_number" SERIAL NOT NULL,
    "account_id" UUID NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "ordered_at" TIMESTAMP(3) NOT NULL,
    "dispatch_by" TIMESTAMP(3),
    "currency" CHAR(3) NOT NULL,
    "prices_include_tax" BOOLEAN NOT NULL DEFAULT true,
    "tax_treatment" TEXT NOT NULL DEFAULT 'seller_liable',
    "settled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_customers" (
    "order_id" UUID NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "line1" TEXT,
    "line2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postcode" TEXT,
    "country" CHAR(2),
    "purge_after" TIMESTAMP(3),
    "purged_at" TIMESTAMP(3),

    CONSTRAINT "order_customers_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "order_lines" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "external_line_id" TEXT NOT NULL,
    "variant_id" UUID,
    "listing_id" UUID,
    "sku" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(14,4) NOT NULL,
    "shipping_charged" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "seller_discount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(14,4),
    "cost_record_id" UUID,
    "fulfilment_cost" DECIMAL(14,4),

    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfilments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "supplier_id" UUID,
    "supplier_order_ref" TEXT,
    "checklist" JSONB,
    "confirmed_at" TIMESTAMP(3),
    "confirmed_source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fulfilments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL,
    "fulfilment_id" UUID NOT NULL,
    "carrier" TEXT,
    "service" TEXT,
    "tracking_number" TEXT,
    "shipped_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "label_cost" DECIMAL(14,4),
    "currency" CHAR(3),
    "pushed_to_marketplace_at" TIMESTAMP(3),

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_line_id" UUID,
    "external_refund_id" TEXT,
    "amount" DECIMAL(14,4) NOT NULL,
    "tax_amount" DECIMAL(14,4),
    "currency" CHAR(3) NOT NULL,
    "reason" TEXT,
    "refunded_at" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "returns" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_line_id" UUID,
    "external_return_id" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "return_shipping_cost" DECIMAL(14,4),
    "currency" CHAR(3),
    "restockable" BOOLEAN,
    "received_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_rules" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "fee_type" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "percent" DECIMAL(9,4),
    "tiers" JSONB,
    "fixed" DECIMAL(14,4),
    "min_fee" DECIMAL(14,4),
    "max_fee" DECIMAL(14,4),
    "category_ids" TEXT[],
    "override_group" TEXT,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "actual_fees" (
    "id" UUID NOT NULL,
    "order_id" UUID,
    "order_line_id" UUID,
    "marketplace" "Marketplace" NOT NULL,
    "fee_type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "source" TEXT NOT NULL,
    "external_ref" TEXT NOT NULL,
    "settlement_id" TEXT,
    "posted_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "actual_fees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currency_rates" (
    "id" UUID NOT NULL,
    "base" CHAR(3) NOT NULL,
    "quote" CHAR(3) NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "as_of" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "currency_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "supplier_id" UUID,
    "marketplace" "Marketplace",
    "notes" TEXT,
    "receipt_key" TEXT,
    "allocation" TEXT NOT NULL DEFAULT 'none',
    "attributed_to_orders" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profit_calculations" (
    "id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "net_revenue" DECIMAL(14,4) NOT NULL,
    "total_cost" DECIMAL(14,4) NOT NULL,
    "total_fees" DECIMAL(14,4) NOT NULL,
    "net_profit" DECIMAL(14,4) NOT NULL,
    "margin_percent" DECIMAL(9,4),
    "reporting_currency" CHAR(3),
    "reporting_net_profit" DECIMAL(14,4),
    "breakdown" JSONB NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "calculated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profit_calculations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "schedule" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "requires_approval" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "summary" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "role_key" TEXT,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "entity_type" TEXT,
    "entity_id" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "actor_id" UUID,
    "actor_email" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "saved_views" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "page" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'products',
    "file_name" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "headers" TEXT[],
    "mapping" JSONB,
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "valid_rows" INTEGER NOT NULL DEFAULT 0,
    "error_rows" INTEGER NOT NULL DEFAULT 0,
    "processed_rows" INTEGER NOT NULL DEFAULT 0,
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "updated_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "data" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "action" TEXT,
    "errors" JSONB,
    "imported_at" TIMESTAMP(3),

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_product_number_key" ON "products"("product_number");

-- CreateIndex
CREATE INDEX "products_status_idx" ON "products"("status");

-- CreateIndex
CREATE INDEX "products_category_idx" ON "products"("category");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_sku_key" ON "product_variants"("sku");

-- CreateIndex
CREATE INDEX "product_variants_product_id_idx" ON "product_variants"("product_id");

-- CreateIndex
CREATE INDEX "product_variants_barcode_idx" ON "product_variants"("barcode");

-- CreateIndex
CREATE UNIQUE INDEX "sku_aliases_type_scope_alias_key" ON "sku_aliases"("type", "scope", "alias");

-- CreateIndex
CREATE INDEX "product_images_product_id_position_idx" ON "product_images"("product_id", "position");

-- CreateIndex
CREATE INDEX "product_images_sha256_idx" ON "product_images"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_name_key" ON "suppliers"("name");

-- CreateIndex
CREATE INDEX "supplier_products_variant_id_priority_idx" ON "supplier_products"("variant_id", "priority");

-- CreateIndex
CREATE INDEX "supplier_products_stock_status_idx" ON "supplier_products"("stock_status");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_products_supplier_id_variant_id_key" ON "supplier_products"("supplier_id", "variant_id");

-- CreateIndex
CREATE INDEX "supplier_price_history_supplier_product_id_observed_at_idx" ON "supplier_price_history"("supplier_product_id", "observed_at");

-- CreateIndex
CREATE INDEX "cost_records_variant_id_effective_from_idx" ON "cost_records"("variant_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_records_variant_id_location_key" ON "inventory_records"("variant_id", "location");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_idempotency_key_key" ON "inventory_movements"("idempotency_key");

-- CreateIndex
CREATE INDEX "inventory_movements_inventory_record_id_created_at_idx" ON "inventory_movements"("inventory_record_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_accounts_marketplace_name_key" ON "marketplace_accounts"("marketplace", "name");

-- CreateIndex
CREATE UNIQUE INDEX "integration_credentials_account_id_key" ON "integration_credentials"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_states_account_id_resource_key" ON "sync_states"("account_id", "resource");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_listings_current_version_id_key" ON "marketplace_listings"("current_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_listings_published_version_id_key" ON "marketplace_listings"("published_version_id");

-- CreateIndex
CREATE INDEX "marketplace_listings_status_idx" ON "marketplace_listings"("status");

-- CreateIndex
CREATE INDEX "marketplace_listings_variant_id_idx" ON "marketplace_listings"("variant_id");

-- CreateIndex
CREATE INDEX "marketplace_listings_marketplace_status_idx" ON "marketplace_listings"("marketplace", "status");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_listings_account_id_sku_key" ON "marketplace_listings"("account_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_listings_account_id_external_listing_id_key" ON "marketplace_listings"("account_id", "external_listing_id");

-- CreateIndex
CREATE UNIQUE INDEX "listing_versions_listing_id_version_key" ON "listing_versions"("listing_id", "version");

-- CreateIndex
CREATE INDEX "listing_validation_results_version_id_ran_at_idx" ON "listing_validation_results"("version_id", "ran_at");

-- CreateIndex
CREATE INDEX "listing_status_history_listing_id_created_at_idx" ON "listing_status_history"("listing_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "listing_publication_jobs_idempotency_key_key" ON "listing_publication_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "listing_publication_jobs_status_next_attempt_at_idx" ON "listing_publication_jobs"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "marketplace_operations_account_id_created_at_idx" ON "marketplace_operations"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "marketplace_operations_entity_type_entity_id_idx" ON "marketplace_operations"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE INDEX "orders_ordered_at_idx" ON "orders"("ordered_at");

-- CreateIndex
CREATE INDEX "orders_status_dispatch_by_idx" ON "orders"("status", "dispatch_by");

-- CreateIndex
CREATE UNIQUE INDEX "orders_account_id_external_order_id_key" ON "orders"("account_id", "external_order_id");

-- CreateIndex
CREATE INDEX "order_lines_variant_id_idx" ON "order_lines"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_lines_order_id_external_line_id_key" ON "order_lines"("order_id", "external_line_id");

-- CreateIndex
CREATE INDEX "order_status_history_order_id_created_at_idx" ON "order_status_history"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "shipments_tracking_number_idx" ON "shipments"("tracking_number");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_order_id_external_refund_id_key" ON "refunds"("order_id", "external_refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "returns_order_id_external_return_id_key" ON "returns"("order_id", "external_return_id");

-- CreateIndex
CREATE INDEX "fee_rules_marketplace_active_idx" ON "fee_rules"("marketplace", "active");

-- CreateIndex
CREATE INDEX "actual_fees_order_id_idx" ON "actual_fees"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "actual_fees_source_external_ref_key" ON "actual_fees"("source", "external_ref");

-- CreateIndex
CREATE INDEX "currency_rates_base_quote_as_of_idx" ON "currency_rates"("base", "quote", "as_of");

-- CreateIndex
CREATE UNIQUE INDEX "currency_rates_base_quote_as_of_source_key" ON "currency_rates"("base", "quote", "as_of", "source");

-- CreateIndex
CREATE INDEX "expenses_date_idx" ON "expenses"("date");

-- CreateIndex
CREATE INDEX "profit_calculations_order_line_id_is_current_idx" ON "profit_calculations"("order_line_id", "is_current");

-- CreateIndex
CREATE INDEX "automation_runs_rule_id_started_at_idx" ON "automation_runs"("rule_id", "started_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "saved_views_user_id_page_name_key" ON "saved_views"("user_id", "page", "name");

-- CreateIndex
CREATE INDEX "import_jobs_created_at_idx" ON "import_jobs"("created_at");

-- CreateIndex
CREATE INDEX "import_rows_job_id_status_idx" ON "import_rows"("job_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "import_rows_job_id_row_number_key" ON "import_rows"("job_id", "row_number");

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "permissions"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku_aliases" ADD CONSTRAINT "sku_aliases_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_price_history" ADD CONSTRAINT "supplier_price_history_supplier_product_id_fkey" FOREIGN KEY ("supplier_product_id") REFERENCES "supplier_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_records" ADD CONSTRAINT "inventory_records_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_inventory_record_id_fkey" FOREIGN KEY ("inventory_record_id") REFERENCES "inventory_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "marketplace_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_states" ADD CONSTRAINT "sync_states_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "marketplace_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "marketplace_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "listing_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_published_version_id_fkey" FOREIGN KEY ("published_version_id") REFERENCES "listing_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_versions" ADD CONSTRAINT "listing_versions_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "marketplace_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_validation_results" ADD CONSTRAINT "listing_validation_results_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "listing_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_status_history" ADD CONSTRAINT "listing_status_history_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "marketplace_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_publication_jobs" ADD CONSTRAINT "listing_publication_jobs_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "marketplace_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_publication_jobs" ADD CONSTRAINT "listing_publication_jobs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "marketplace_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_operations" ADD CONSTRAINT "marketplace_operations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "marketplace_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "marketplace_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_customers" ADD CONSTRAINT "order_customers_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "marketplace_listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_cost_record_id_fkey" FOREIGN KEY ("cost_record_id") REFERENCES "cost_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfilments" ADD CONSTRAINT "fulfilments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_fulfilment_id_fkey" FOREIGN KEY ("fulfilment_id") REFERENCES "fulfilments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actual_fees" ADD CONSTRAINT "actual_fees_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profit_calculations" ADD CONSTRAINT "profit_calculations_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "order_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "automation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────── Integrity constraints beyond Prisma's DSL ───────────────────────────

-- Master SKUs are unique regardless of case (FR-10001 == fr-10001).
CREATE UNIQUE INDEX "product_variants_sku_lower_key" ON "product_variants" (lower("sku"));

-- Stock buckets can never go negative.
ALTER TABLE "inventory_records"
  ADD CONSTRAINT "inventory_non_negative" CHECK (
    "available" >= 0 AND "reserved" >= 0 AND "committed" >= 0 AND "damaged" >= 0 AND "returned" >= 0 AND "safety_stock" >= 0
  );
ALTER TABLE "inventory_movements" ADD CONSTRAINT "movement_quantity_positive" CHECK ("quantity" > 0);

-- Effective-dated costs: at most one open record per variant, and periods are well-formed.
CREATE UNIQUE INDEX "cost_records_one_open_per_variant" ON "cost_records" ("variant_id") WHERE "effective_to" IS NULL;
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_period_valid" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_amounts_non_negative" CHECK (
  "supplier_price" >= 0 AND "supplier_shipping" >= 0 AND "packaging" >= 0 AND "import_duty" >= 0
  AND "non_recoverable_tax" >= 0 AND "other_per_unit" >= 0
);

-- Money and quantities on listings / orders.
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "listing_price_positive" CHECK ("price" IS NULL OR "price" > 0);
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "listing_quantity_non_negative" CHECK ("quantity" >= 0);
ALTER TABLE "order_lines" ADD CONSTRAINT "order_line_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "currency_rates" ADD CONSTRAINT "currency_rate_positive" CHECK ("rate" > 0);
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_price_non_negative" CHECK ("current_price" >= 0 AND "shipping_cost" >= 0);

-- An ACTIVE listing must carry the marketplace's listing id (it is only set from a marketplace confirmation).
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "active_listing_has_external_id"
  CHECK ("status" NOT IN ('ACTIVE', 'PAUSED') OR "external_listing_id" IS NOT NULL);

-- Audit log is append-only.
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

-- Trigram search for products / SKUs (global search across 20k+ products).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "products_title_trgm" ON "products" USING gin ("title" gin_trgm_ops);
CREATE INDEX "product_variants_sku_trgm" ON "product_variants" USING gin ("sku" gin_trgm_ops);
