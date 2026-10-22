-- AlterEnum
ALTER TYPE "PaymentProviderCode" ADD VALUE 'PEARL';

-- CreateTable
CREATE TABLE "pearl_settings" (
    "operatorId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'review_all',
    "currency" TEXT NOT NULL,
    "autoMaxAmount" BIGINT NOT NULL,
    "minAmount" BIGINT NOT NULL,
    "maxAgeHours" INTEGER NOT NULL DEFAULT 48,
    "waitBankMinutes" INTEGER NOT NULL DEFAULT 20,
    "utcOffsetMinutes" INTEGER NOT NULL DEFAULT -180,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pearl_settings_pkey" PRIMARY KEY ("operatorId")
);

-- CreateTable
CREATE TABLE "pearl_bank_accounts" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "holderName" TEXT NOT NULL,
    "alias" TEXT,
    "accountNumber" TEXT NOT NULL,
    "bank" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pearl_bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pearl_feeds" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastEventAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pearl_feeds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pearl_bank_txs" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "feedId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "senderName" TEXT NOT NULL,
    "senderTaxId" TEXT,
    "senderAccount" TEXT,
    "receiverAccount" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "receiptId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pearl_bank_txs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pearl_receipts" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "conversationId" UUID,
    "playerId" TEXT,
    "imageHash" TEXT,
    "extracted" JSONB NOT NULL,
    "key" TEXT,
    "amount" BIGINT,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "checks" JSONB NOT NULL,
    "bankTxId" UUID,
    "depositId" TEXT,
    "source" TEXT NOT NULL,
    "reviewerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pearl_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pearl_bank_accounts_operatorId_idx" ON "pearl_bank_accounts"("operatorId");

-- CreateIndex
CREATE INDEX "pearl_feeds_operatorId_idx" ON "pearl_feeds"("operatorId");

-- CreateIndex
CREATE INDEX "pearl_bank_txs_operatorId_status_amount_idx" ON "pearl_bank_txs"("operatorId", "status", "amount");

-- CreateIndex
CREATE UNIQUE INDEX "pearl_bank_txs_feedId_externalId_key" ON "pearl_bank_txs"("feedId", "externalId");

-- CreateIndex
CREATE INDEX "pearl_receipts_operatorId_status_createdAt_idx" ON "pearl_receipts"("operatorId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "pearl_receipts_status_idx" ON "pearl_receipts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "pearl_receipts_operatorId_imageHash_key" ON "pearl_receipts"("operatorId", "imageHash");

-- CreateIndex
CREATE UNIQUE INDEX "pearl_receipts_operatorId_key_key" ON "pearl_receipts"("operatorId", "key");

