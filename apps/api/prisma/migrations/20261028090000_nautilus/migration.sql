-- CreateTable
CREATE TABLE "nautilus_findings" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'open',
    "notifiedAt" TIMESTAMP(3),
    "ackBy" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "nautilus_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nautilus_reports" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nautilus_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "nautilus_findings_operatorId_status_idx" ON "nautilus_findings"("operatorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "nautilus_findings_operatorId_key_key" ON "nautilus_findings"("operatorId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "nautilus_reports_operatorId_day_key" ON "nautilus_reports"("operatorId", "day");

