-- CreateTable
CREATE TABLE "listing_templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "title_template" TEXT NOT NULL,
    "description_template" TEXT NOT NULL,
    "bullet_templates" TEXT[],
    "defaults" JSONB NOT NULL DEFAULT '{}',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "listing_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "listing_templates_marketplace_name_key" ON "listing_templates"("marketplace", "name");

