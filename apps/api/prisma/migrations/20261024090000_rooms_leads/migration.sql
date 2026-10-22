-- AlterTable
ALTER TABLE "inbox_conversations" ADD COLUMN     "stage" TEXT NOT NULL DEFAULT 'new_lead';

-- AlterTable
ALTER TABLE "pearl_settings" ADD COLUMN     "autoRegisterLeads" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "inbox_conversations_operatorId_stage_idx" ON "inbox_conversations"("operatorId", "stage");

