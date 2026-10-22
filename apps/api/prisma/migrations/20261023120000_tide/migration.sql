-- CreateTable
CREATE TABLE "tide_flows" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "draft" JSONB NOT NULL,
    "publishedVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tide_flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tide_flow_versions" (
    "flowId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "graph" JSONB NOT NULL,
    "publishedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tide_flow_versions_pkey" PRIMARY KEY ("flowId","version")
);

-- CreateTable
CREATE TABLE "tide_sessions" (
    "conversationId" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "flowId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "nodeId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "vars" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "trace" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tide_sessions_pkey" PRIMARY KEY ("conversationId")
);

-- CreateIndex
CREATE INDEX "tide_flows_operatorId_idx" ON "tide_flows"("operatorId");

-- CreateIndex
CREATE INDEX "tide_sessions_status_expiresAt_idx" ON "tide_sessions"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "tide_sessions_flowId_idx" ON "tide_sessions"("flowId");

