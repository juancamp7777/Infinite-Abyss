-- CreateEnum
CREATE TYPE "OperatorStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NONE', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BackofficeRole" AS ENUM ('PLATFORM_ADMIN', 'OPERATOR_ADMIN', 'OPERATOR_SUPPORT', 'OPERATOR_FINANCE');

-- CreateEnum
CREATE TYPE "LedgerOwnerType" AS ENUM ('PLAYER', 'OPERATOR');

-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('PLAYER_CASH', 'PLAYER_BONUS', 'HOUSE', 'PSP_CLEARING', 'WITHDRAWAL_PENDING', 'BONUS_EXPENSE', 'MANUAL_ADJUSTMENT', 'DEMO_FUNDING');

-- CreateEnum
CREATE TYPE "LedgerTxType" AS ENUM ('DEPOSIT', 'WITHDRAWAL_RESERVE', 'WITHDRAWAL_RELEASE', 'WITHDRAWAL_PAYOUT', 'BET', 'WIN', 'ROLLBACK', 'MANUAL_ADJUSTMENT', 'DEMO_CREDIT');

-- CreateEnum
CREATE TYPE "PaymentProviderCode" AS ENUM ('PASSIMPAY', 'WOMPI');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('CREATED', 'PENDING', 'CONFIRMED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING', 'PAID', 'FAILED');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('BACKOFFICE_USER', 'PLAYER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "GameType" AS ENUM ('ROULETTE', 'SLOTS', 'BLACKJACK', 'MINES', 'CRASH', 'PLINKO');

-- CreateEnum
CREATE TYPE "GameStatus" AS ENUM ('ACTIVE', 'FINISHED');

-- CreateTable
CREATE TABLE "Operator" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "OperatorStatus" NOT NULL DEFAULT 'ACTIVE',
    "defaultCurrency" TEXT NOT NULL,
    "currencies" TEXT[],
    "chipsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "chipMinorUnitsPerChip" BIGINT,
    "limits" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Operator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatorDomain" (
    "id" UUID NOT NULL,
    "host" TEXT NOT NULL,
    "operatorId" UUID NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperatorDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatorBrand" (
    "id" UUID NOT NULL,
    "operatorId" UUID NOT NULL,
    "displayName" TEXT NOT NULL,
    "logoUrl" TEXT NOT NULL,
    "faviconUrl" TEXT,
    "colors" JSONB NOT NULL,
    "fontFamily" TEXT NOT NULL,
    "legal" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatorBrand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "operatorId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "username" TEXT,
    "passwordHash" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'NONE',
    "currency" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResponsibleGamingSettings" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "operatorId" UUID NOT NULL,
    "depositLimitDaily" BIGINT,
    "depositLimitWeekly" BIGINT,
    "depositLimitMonthly" BIGINT,
    "lossLimitDaily" BIGINT,
    "lossLimitWeekly" BIGINT,
    "lossLimitMonthly" BIGINT,
    "sessionTimeLimitMinutes" INTEGER,
    "selfExcludedUntil" TIMESTAMP(3),
    "selfExclusionPermanent" BOOLEAN NOT NULL DEFAULT false,
    "coolOffUntil" TIMESTAMP(3),
    "pendingLimitIncrease" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResponsibleGamingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "operatorId" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "PlayerSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackofficeUser" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "BackofficeRole" NOT NULL,
    "operatorId" UUID,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackofficeUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" UUID,
    "backofficeUserId" UUID,
    "operatorId" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedById" UUID,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" UUID NOT NULL,
    "operatorId" UUID NOT NULL,
    "ownerType" "LedgerOwnerType" NOT NULL,
    "userId" UUID,
    "ownerKey" TEXT NOT NULL,
    "type" "LedgerAccountType" NOT NULL,
    "currency" TEXT NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerTransaction" (
    "id" UUID NOT NULL,
    "operatorId" UUID NOT NULL,
    "type" "LedgerTxType" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "reversesId" UUID,
    "metadata" JSONB,
    "createdByBackofficeUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "operatorId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deposit" (
    "id" UUID NOT NULL,
    "operatorId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "PaymentProviderCode" NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'CREATED',
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "providerReference" TEXT NOT NULL,
    "externalId" TEXT,
    "ledgerTransactionId" UUID,
    "rawCreateResponse" JSONB,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Withdrawal" (
    "id" UUID NOT NULL,
    "operatorId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "PaymentProviderCode" NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'REQUESTED',
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "destination" JSONB NOT NULL,
    "externalId" TEXT,
    "reserveLedgerTxId" UUID NOT NULL,
    "settleLedgerTxId" UUID,
    "reviewedByBackofficeUserId" UUID,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" UUID NOT NULL,
    "provider" "PaymentProviderCode" NOT NULL,
    "dedupeKey" TEXT,
    "signatureValid" BOOLEAN NOT NULL,
    "headers" JSONB NOT NULL,
    "rawBody" TEXT NOT NULL,
    "parsed" JSONB,
    "sourceIp" TEXT,
    "processedAt" TIMESTAMP(3),
    "result" TEXT,
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "operatorId" UUID,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameSession" (
    "id" UUID NOT NULL,
    "operatorId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "gameType" "GameType" NOT NULL,
    "status" "GameStatus" NOT NULL DEFAULT 'ACTIVE',
    "betAmount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Operator_slug_key" ON "Operator"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "OperatorDomain_host_key" ON "OperatorDomain"("host");

-- CreateIndex
CREATE INDEX "OperatorDomain_operatorId_idx" ON "OperatorDomain"("operatorId");

-- CreateIndex
CREATE UNIQUE INDEX "OperatorBrand_operatorId_key" ON "OperatorBrand"("operatorId");

-- CreateIndex
CREATE INDEX "User_operatorId_idx" ON "User"("operatorId");

-- CreateIndex
CREATE UNIQUE INDEX "User_operatorId_emailNormalized_key" ON "User"("operatorId", "emailNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "User_operatorId_username_key" ON "User"("operatorId", "username");

-- CreateIndex
CREATE UNIQUE INDEX "ResponsibleGamingSettings_userId_key" ON "ResponsibleGamingSettings"("userId");

-- CreateIndex
CREATE INDEX "ResponsibleGamingSettings_operatorId_idx" ON "ResponsibleGamingSettings"("operatorId");

-- CreateIndex
CREATE INDEX "PlayerSession_userId_startedAt_idx" ON "PlayerSession"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "PlayerSession_operatorId_idx" ON "PlayerSession"("operatorId");

-- CreateIndex
CREATE UNIQUE INDEX "BackofficeUser_email_key" ON "BackofficeUser"("email");

-- CreateIndex
CREATE INDEX "BackofficeUser_operatorId_idx" ON "BackofficeUser"("operatorId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_backofficeUserId_idx" ON "RefreshToken"("backofficeUserId");

-- CreateIndex
CREATE INDEX "LedgerAccount_userId_idx" ON "LedgerAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_operatorId_ownerKey_type_currency_key" ON "LedgerAccount"("operatorId", "ownerKey", "type", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerTransaction_reversesId_key" ON "LedgerTransaction"("reversesId");

-- CreateIndex
CREATE INDEX "LedgerTransaction_operatorId_createdAt_idx" ON "LedgerTransaction"("operatorId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerTransaction_referenceType_referenceId_idx" ON "LedgerTransaction"("referenceType", "referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerTransaction_operatorId_idempotencyKey_key" ON "LedgerTransaction"("operatorId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_idx" ON "LedgerEntry"("accountId");

-- CreateIndex
CREATE INDEX "LedgerEntry_transactionId_idx" ON "LedgerEntry"("transactionId");

-- CreateIndex
CREATE INDEX "LedgerEntry_operatorId_currency_idx" ON "LedgerEntry"("operatorId", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_providerReference_key" ON "Deposit"("providerReference");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_ledgerTransactionId_key" ON "Deposit"("ledgerTransactionId");

-- CreateIndex
CREATE INDEX "Deposit_operatorId_userId_idx" ON "Deposit"("operatorId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_provider_externalId_key" ON "Deposit"("provider", "externalId");

-- CreateIndex
CREATE INDEX "Withdrawal_operatorId_status_idx" ON "Withdrawal"("operatorId", "status");

-- CreateIndex
CREATE INDEX "Withdrawal_userId_idx" ON "Withdrawal"("userId");

-- CreateIndex
CREATE INDEX "WebhookEvent_receivedAt_idx" ON "WebhookEvent"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_dedupeKey_key" ON "WebhookEvent"("provider", "dedupeKey");

-- CreateIndex
CREATE INDEX "AuditLog_operatorId_createdAt_idx" ON "AuditLog"("operatorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "GameSession_operatorId_userId_idx" ON "GameSession"("operatorId", "userId");

-- AddForeignKey
ALTER TABLE "OperatorDomain" ADD CONSTRAINT "OperatorDomain_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorBrand" ADD CONSTRAINT "OperatorBrand_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResponsibleGamingSettings" ADD CONSTRAINT "ResponsibleGamingSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResponsibleGamingSettings" ADD CONSTRAINT "ResponsibleGamingSettings_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerSession" ADD CONSTRAINT "PlayerSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerSession" ADD CONSTRAINT "PlayerSession_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackofficeUser" ADD CONSTRAINT "BackofficeUser_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_backofficeUserId_fkey" FOREIGN KEY ("backofficeUserId") REFERENCES "BackofficeUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerTransaction" ADD CONSTRAINT "LedgerTransaction_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameSession" ADD CONSTRAINT "GameSession_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameSession" ADD CONSTRAINT "GameSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────
-- Inmutabilidad del ledger: se permite INSERT, nunca UPDATE/DELETE.
-- (No hay trigger de suma cero a propósito: la reconciliación debe poder
-- detectar descuadres inyectados.)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION nymfo_ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger is immutable: % on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerEntry_immutable"
  BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION nymfo_ledger_immutable();

CREATE TRIGGER "LedgerTransaction_immutable"
  BEFORE UPDATE OR DELETE ON "LedgerTransaction"
  FOR EACH ROW EXECUTE FUNCTION nymfo_ledger_immutable();
