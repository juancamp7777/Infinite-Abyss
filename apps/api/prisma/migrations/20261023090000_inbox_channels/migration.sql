-- AlterTable
ALTER TABLE "inbox_conversations" ADD COLUMN     "channelId" UUID;

-- AlterTable
ALTER TABLE "inbox_messages" ADD COLUMN     "error" TEXT,
ADD COLUMN     "externalMessageId" TEXT,
ADD COLUMN     "status" TEXT;

-- CreateTable
CREATE TABLE "inbox_channels" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "webhookSecret" TEXT NOT NULL,
    "configEnc" TEXT NOT NULL,
    "publicInfo" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbox_channels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inbox_channels_operatorId_idx" ON "inbox_channels"("operatorId");

