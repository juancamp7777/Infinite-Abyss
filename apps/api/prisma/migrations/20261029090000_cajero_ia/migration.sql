-- CreateTable
CREATE TABLE "pearl_bot_configs" (
    "operatorId" TEXT NOT NULL,
    "draft" JSONB NOT NULL,
    "publishedVersion" INTEGER,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pearl_bot_configs_pkey" PRIMARY KEY ("operatorId")
);

-- CreateTable
CREATE TABLE "pearl_bot_config_versions" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "publishedBy" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pearl_bot_config_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pearl_promo_claims" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "promoId" TEXT NOT NULL,
    "playerKey" TEXT NOT NULL,
    "observed" BOOLEAN NOT NULL DEFAULT false,
    "amount" BIGINT,
    "refKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pearl_promo_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pearl_bot_config_versions_operatorId_version_key" ON "pearl_bot_config_versions"("operatorId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "pearl_promo_claims_refKey_key" ON "pearl_promo_claims"("refKey");

-- CreateIndex
CREATE INDEX "pearl_promo_claims_operatorId_promoId_playerKey_idx" ON "pearl_promo_claims"("operatorId", "promoId", "playerKey");
