-- CreateTable
CREATE TABLE "crew_activities" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "memberId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "xp" INTEGER NOT NULL,
    "value" INTEGER,
    "refKey" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crew_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crew_response_clocks" (
    "conversationId" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "waitingSince" TIMESTAMP(3),

    CONSTRAINT "crew_response_clocks_pkey" PRIMARY KEY ("conversationId")
);

-- CreateIndex
CREATE UNIQUE INDEX "crew_activities_refKey_key" ON "crew_activities"("refKey");

-- CreateIndex
CREATE INDEX "crew_activities_operatorId_at_idx" ON "crew_activities"("operatorId", "at");

-- CreateIndex
CREATE INDEX "crew_activities_memberId_at_idx" ON "crew_activities"("memberId", "at");

