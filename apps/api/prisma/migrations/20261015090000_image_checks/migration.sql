-- Automated image checks (text / watermark, background, collage). Advisory results only.
ALTER TABLE "product_images" ADD COLUMN "check_result" JSONB;
ALTER TABLE "product_images" ADD COLUMN "checked_at" TIMESTAMP(3);
CREATE INDEX "product_images_unchecked_idx" ON "product_images" ("created_at") WHERE "checked_at" IS NULL;
