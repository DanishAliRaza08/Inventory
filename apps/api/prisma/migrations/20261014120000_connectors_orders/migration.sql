-- AlterTable
ALTER TABLE "listing_publication_jobs" ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "payload" JSONB;

-- CreateTable
CREATE TABLE "supplier_connections" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_CONNECTED',
    "ciphertext" TEXT,
    "iv" TEXT,
    "auth_tag" TEXT,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMP(3),
    "last_sync_at" TIMESTAMP(3),
    "last_error" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_orders" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "fulfilment_id" UUID,
    "external_order_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "total_cost" DECIMAL(14,4),
    "currency" CHAR(3),
    "tracking_number" TEXT,
    "carrier" TEXT,
    "placed_by_id" UUID,
    "placed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_connections_supplier_id_key" ON "supplier_connections"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_orders_idempotency_key_key" ON "supplier_orders"("idempotency_key");

-- CreateIndex
CREATE INDEX "supplier_orders_order_id_idx" ON "supplier_orders"("order_id");

-- AddForeignKey
ALTER TABLE "supplier_connections" ADD CONSTRAINT "supplier_connections_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_orders" ADD CONSTRAINT "supplier_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

