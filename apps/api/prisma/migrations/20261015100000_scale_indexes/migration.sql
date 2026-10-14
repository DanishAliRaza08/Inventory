-- Indexes found missing by the load test (20k products / 100k listings / 100k orders).
CREATE INDEX "products_created_at_id_idx" ON "products" ("created_at", "id");
CREATE INDEX "marketplace_listings_product_id_idx" ON "marketplace_listings" ("product_id");
CREATE INDEX "marketplace_listings_updated_at_id_idx" ON "marketplace_listings" ("updated_at", "id");
CREATE INDEX "marketplace_listings_status_updated_at_id_idx" ON "marketplace_listings" ("status", "updated_at", "id");
CREATE INDEX "marketplace_listings_external_listing_id_idx" ON "marketplace_listings" ("external_listing_id");
CREATE INDEX "marketplace_listings_sku_trgm" ON "marketplace_listings" USING gin ("sku" gin_trgm_ops);
CREATE INDEX "sku_aliases_alias_lower_idx" ON "sku_aliases" (lower("alias"));
CREATE INDEX "supplier_products_supplier_sku_idx" ON "supplier_products" ("supplier_sku");
CREATE INDEX "supplier_products_supplier_product_id_idx" ON "supplier_products" ("supplier_product_id");
CREATE INDEX "order_lines_listing_id_idx" ON "order_lines" ("listing_id");
CREATE INDEX "inventory_records_variant_available_idx" ON "inventory_records" ("variant_id") WHERE "available" <> 0;
CREATE INDEX "marketplace_listings_sku_lower_idx" ON "marketplace_listings" (lower("sku"));
