-- CreateTable
CREATE TABLE "crew_members" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "backofficeUserId" UUID,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "team" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
    "payType" TEXT NOT NULL DEFAULT 'monthly',
    "baseAmount" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "dayOff" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crew_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crew_shifts" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "memberId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crew_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crew_sessions" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "memberId" UUID NOT NULL,
    "openKey" TEXT,
    "shiftId" UUID,
    "kind" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'working',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "pauses" JSONB NOT NULL DEFAULT '[]',
    "netMinutes" INTEGER,
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "closedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crew_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crew_tasks" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "assigneeId" UUID,
    "status" TEXT NOT NULL DEFAULT 'todo',
    "dueAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crew_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crew_checklist_items" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "shiftLabel" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crew_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crew_checklist_marks" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "markedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crew_checklist_marks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crew_announcements" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crew_announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crew_announcement_reads" (
    "announcementId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crew_announcement_reads_pkey" PRIMARY KEY ("announcementId","memberId")
);

-- CreateTable
CREATE TABLE "crew_cash_sessions" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "openKey" TEXT,
    "box" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "openedBy" UUID NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingBalance" BIGINT NOT NULL,
    "closedBy" UUID,
    "closedAt" TIMESTAMP(3),
    "expectedBalance" BIGINT,
    "declaredBalance" BIGINT,
    "difference" BIGINT,
    "snapshot" JSONB,
    "status" TEXT NOT NULL DEFAULT 'open',
    "reopenedBy" TEXT,
    "reopenReason" TEXT,

    CONSTRAINT "crew_cash_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crew_cash_movements" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "concept" TEXT NOT NULL,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crew_cash_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crew_payroll_adjustments" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "memberId" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crew_payroll_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crew_payroll_closes" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "memberId" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "closedBy" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "paidBy" TEXT,

    CONSTRAINT "crew_payroll_closes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crew_members_operatorId_active_idx" ON "crew_members"("operatorId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "crew_members_operatorId_backofficeUserId_key" ON "crew_members"("operatorId", "backofficeUserId");

-- CreateIndex
CREATE INDEX "crew_shifts_operatorId_startsAt_idx" ON "crew_shifts"("operatorId", "startsAt");

-- CreateIndex
CREATE INDEX "crew_shifts_memberId_startsAt_idx" ON "crew_shifts"("memberId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "crew_sessions_openKey_key" ON "crew_sessions"("openKey");

-- CreateIndex
CREATE INDEX "crew_sessions_operatorId_startedAt_idx" ON "crew_sessions"("operatorId", "startedAt");

-- CreateIndex
CREATE INDEX "crew_sessions_memberId_startedAt_idx" ON "crew_sessions"("memberId", "startedAt");

-- CreateIndex
CREATE INDEX "crew_tasks_operatorId_status_idx" ON "crew_tasks"("operatorId", "status");

-- CreateIndex
CREATE INDEX "crew_tasks_assigneeId_status_idx" ON "crew_tasks"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "crew_checklist_items_operatorId_active_idx" ON "crew_checklist_items"("operatorId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "crew_checklist_marks_itemId_memberId_day_key" ON "crew_checklist_marks"("itemId", "memberId", "day");

-- CreateIndex
CREATE INDEX "crew_announcements_operatorId_createdAt_idx" ON "crew_announcements"("operatorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "crew_cash_sessions_openKey_key" ON "crew_cash_sessions"("openKey");

-- CreateIndex
CREATE INDEX "crew_cash_sessions_operatorId_openedAt_idx" ON "crew_cash_sessions"("operatorId", "openedAt");

-- CreateIndex
CREATE INDEX "crew_cash_movements_sessionId_idx" ON "crew_cash_movements"("sessionId");

-- CreateIndex
CREATE INDEX "crew_payroll_adjustments_operatorId_month_idx" ON "crew_payroll_adjustments"("operatorId", "month");

-- CreateIndex
CREATE INDEX "crew_payroll_closes_operatorId_month_idx" ON "crew_payroll_closes"("operatorId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "crew_payroll_closes_memberId_month_key" ON "crew_payroll_closes"("memberId", "month");

