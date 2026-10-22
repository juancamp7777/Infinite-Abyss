-- CreateTable
CREATE TABLE "reef_site_drafts" (
    "operatorId" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reef_site_drafts_pkey" PRIMARY KEY ("operatorId")
);

-- CreateTable
CREATE TABLE "reef_site_versions" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "publishedBy" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reef_site_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reef_assets" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reef_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reef_site_versions_operatorId_status_idx" ON "reef_site_versions"("operatorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "reef_site_versions_operatorId_version_key" ON "reef_site_versions"("operatorId", "version");

-- CreateIndex
CREATE INDEX "reef_assets_operatorId_idx" ON "reef_assets"("operatorId");

