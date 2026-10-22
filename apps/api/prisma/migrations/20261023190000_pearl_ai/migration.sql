-- AlterTable
ALTER TABLE "inbox_messages" ADD COLUMN     "attachmentId" UUID;

-- AlterTable
ALTER TABLE "pearl_receipts" ADD COLUMN     "attachmentId" UUID;

-- CreateTable
CREATE TABLE "inbox_attachments" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "conversationId" UUID NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pearl_ai_configs" (
    "operatorId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "provider" TEXT NOT NULL,
    "readerModel" TEXT NOT NULL,
    "judgeModel" TEXT NOT NULL,
    "keyEnc" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pearl_ai_configs_pkey" PRIMARY KEY ("operatorId")
);

-- CreateIndex
CREATE INDEX "inbox_attachments_operatorId_conversationId_idx" ON "inbox_attachments"("operatorId", "conversationId");

