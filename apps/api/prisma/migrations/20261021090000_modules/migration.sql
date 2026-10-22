-- Infinite Abyss · módulos (Hub, Studios, promociones, CRM, marketing, gamificación, backoffice).
-- Generada con prisma migrate diff desde el esquema de 20261020190000_init. Requiere PostgreSQL >= 12
-- (varios ADD VALUE de enum en la misma transacción; los valores nuevos no se usan en esta migración).
-- Las tablas de módulos no tienen FK hacia la Fase 1: operatorId/playerId se guardan como texto.

-- AlterEnum
ALTER TYPE "LedgerAccountType" ADD VALUE 'JACKPOT_POOL';
ALTER TYPE "LedgerAccountType" ADD VALUE 'TOURNAMENT_POOL';
ALTER TYPE "LedgerAccountType" ADD VALUE 'CASHBACK_EXPENSE';

-- AlterEnum
ALTER TYPE "LedgerTxType" ADD VALUE 'BONUS_GRANT';
ALTER TYPE "LedgerTxType" ADD VALUE 'BONUS_CONVERT';
ALTER TYPE "LedgerTxType" ADD VALUE 'BONUS_FORFEIT';
ALTER TYPE "LedgerTxType" ADD VALUE 'CASHBACK';
ALTER TYPE "LedgerTxType" ADD VALUE 'JACKPOT_CONTRIBUTION';
ALTER TYPE "LedgerTxType" ADD VALUE 'JACKPOT_PAYOUT';
ALTER TYPE "LedgerTxType" ADD VALUE 'TOURNAMENT_BUYIN';
ALTER TYPE "LedgerTxType" ADD VALUE 'TOURNAMENT_PRIZE';
ALTER TYPE "LedgerTxType" ADD VALUE 'REFUND';

-- CreateTable
CREATE TABLE "hub_providers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hub_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub_games" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "mechanic" TEXT NOT NULL,
    "rtp" DECIMAL(5,2) NOT NULL,
    "volatility" TEXT NOT NULL,
    "images" JSONB NOT NULL,
    "tags" TEXT[],
    "allowedMarkets" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "hasDemo" BOOLEAN NOT NULL DEFAULT true,
    "releasedAt" TIMESTAMP(3) NOT NULL,
    "popularity" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hub_games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub_operator_games" (
    "operatorId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "hub_operator_games_pkey" PRIMARY KEY ("operatorId","gameId")
);

-- CreateTable
CREATE TABLE "hub_sessions" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "walletKind" TEXT NOT NULL,
    "remoteOperatorId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hub_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub_rounds" (
    "id" UUID NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerRoundId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "betAmount" BIGINT NOT NULL DEFAULT 0,
    "winAmount" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "hub_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub_transactions" (
    "id" UUID NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerTxId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "providerRoundId" TEXT,
    "gameId" TEXT,
    "sessionId" TEXT,
    "referenceTxId" TEXT,
    "walletTxId" TEXT,
    "fingerprint" TEXT NOT NULL,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hub_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub_remote_operators" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "walletCallbackUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "currencies" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hub_remote_operators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio_rounds" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "bet" BIGINT NOT NULL,
    "baseBet" BIGINT NOT NULL,
    "win" BIGINT NOT NULL DEFAULT 0,
    "multiplier" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "outcome" JSONB,
    "state" JSONB,
    "params" JSONB NOT NULL,
    "rtp" DOUBLE PRECISION NOT NULL,
    "rtpProfile" TEXT,
    "bonusBuy" BOOLEAN NOT NULL DEFAULT false,
    "serverSeedHash" TEXT NOT NULL,
    "clientSeed" TEXT NOT NULL,
    "nonce" INTEGER NOT NULL,
    "seedPairId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "debits" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "studio_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio_seed_pairs" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "serverSeed" TEXT NOT NULL,
    "serverSeedHash" TEXT NOT NULL,
    "clientSeed" TEXT NOT NULL,
    "nonce" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revealedAt" TIMESTAMP(3),

    CONSTRAINT "studio_seed_pairs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio_operator_configs" (
    "operatorId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "rtp" DOUBLE PRECISION,
    "rtpProfile" TEXT,
    "minBet" BIGINT,
    "maxBet" BIGINT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "studio_operator_configs_pkey" PRIMARY KEY ("operatorId","gameId")
);

-- CreateTable
CREATE TABLE "promo_bonus_templates" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "currency" TEXT NOT NULL,
    "code" TEXT,
    "maxUsesTotal" INTEGER,
    "maxUsesPerPlayer" INTEGER,
    "usesCount" INTEGER NOT NULL DEFAULT 0,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "autoOnDeposit" BOOLEAN NOT NULL DEFAULT false,
    "firstDepositOnly" BOOLEAN NOT NULL DEFAULT false,
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "matchBps" INTEGER,
    "minDeposit" BIGINT,
    "maxBonusAmount" BIGINT,
    "fixedAmount" BIGINT,
    "freeSpinGameId" TEXT,
    "freeSpinCount" INTEGER,
    "freeSpinValue" BIGINT,
    "cashbackBps" INTEGER,
    "wageringMultiplier" INTEGER NOT NULL DEFAULT 0,
    "wageringBase" TEXT NOT NULL DEFAULT 'BONUS',
    "contributionBps" JSONB NOT NULL,
    "excludedGameIds" TEXT[],
    "maxBet" BIGINT,
    "maxConversion" BIGINT,
    "validityHours" INTEGER NOT NULL DEFAULT 168,
    "claimWindowHours" INTEGER NOT NULL DEFAULT 24,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promo_bonus_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_code_redemptions" (
    "id" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "playerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_code_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_player_bonuses" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "templateId" UUID,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'WAGERING',
    "currency" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "depositAmount" BIGINT NOT NULL DEFAULT 0,
    "wageringMultiplier" INTEGER NOT NULL DEFAULT 0,
    "wageringBase" TEXT NOT NULL DEFAULT 'BONUS',
    "wageringRequired" BIGINT NOT NULL DEFAULT 0,
    "wageringProgress" BIGINT NOT NULL DEFAULT 0,
    "contributionBps" JSONB NOT NULL,
    "excludedGameIds" TEXT[],
    "maxBet" BIGINT,
    "maxConversion" BIGINT,
    "freeSpinGameId" TEXT,
    "freeSpinsTotal" INTEGER NOT NULL DEFAULT 0,
    "freeSpinsUsed" INTEGER NOT NULL DEFAULT 0,
    "freeSpinsSettled" INTEGER NOT NULL DEFAULT 0,
    "freeSpinValue" BIGINT,
    "freeSpinWin" BIGINT NOT NULL DEFAULT 0,
    "validityHours" INTEGER NOT NULL DEFAULT 168,
    "expiresAt" TIMESTAMP(3),
    "grantTxId" TEXT,
    "settlementAmount" BIGINT NOT NULL DEFAULT 0,
    "settlementTxId" TEXT,
    "statusReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "promo_player_bonuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_bonus_rounds" (
    "bonusId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "contribution" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_bonus_rounds_pkey" PRIMARY KEY ("bonusId","key")
);

-- CreateTable
CREATE TABLE "promo_settled_rounds" (
    "operatorId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "win" BIGINT NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promo_settled_rounds_pkey" PRIMARY KEY ("operatorId","roundId")
);

-- CreateTable
CREATE TABLE "promo_jackpots" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "contributionBps" INTEGER NOT NULL,
    "minBet" BIGINT NOT NULL DEFAULT 0,
    "gameIds" TEXT[],
    "categories" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promo_jackpots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_jackpot_levels" (
    "id" UUID NOT NULL,
    "jackpotId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "seedAmount" BIGINT NOT NULL,
    "shareBps" INTEGER NOT NULL,
    "triggerChancePpm" INTEGER NOT NULL,
    "mustDropBy" BIGINT,
    "dropPoint" BIGINT,
    "currentAmount" BIGINT NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "promo_jackpot_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_jackpot_contributions" (
    "id" UUID NOT NULL,
    "jackpotId" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "betAmount" BIGINT NOT NULL,
    "amount" BIGINT NOT NULL,
    "perLevel" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_jackpot_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_jackpot_seed_funding" (
    "id" UUID NOT NULL,
    "jackpotId" UUID NOT NULL,
    "levelKey" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_jackpot_seed_funding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_jackpot_wins" (
    "id" UUID NOT NULL,
    "jackpotId" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "levelKey" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "txId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "promo_jackpot_wins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_drop_campaigns" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "minBet" BIGINT NOT NULL DEFAULT 0,
    "dropChancePpm" INTEGER NOT NULL,
    "gameIds" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_drop_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_drop_prizes" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "awarded" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "promo_drop_prizes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_drop_awards" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "prizeId" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "txId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_drop_awards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_player_profiles" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "lastActivityAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_player_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_processed_events" (
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_processed_events_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "crm_notes" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_timeline_entries" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "data" JSONB,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_timeline_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_tickets" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "assignedTo" TEXT,
    "messages" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_segments" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rule" JSONB NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_operator_brands" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT,
    "refId" TEXT,
    "status" TEXT,
    "dueAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_operator_brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_templates" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT,
    "refId" TEXT,
    "status" TEXT,
    "dueAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_campaigns" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT,
    "refId" TEXT,
    "status" TEXT,
    "dueAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_journeys" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT,
    "refId" TEXT,
    "status" TEXT,
    "dueAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_journeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_journey_runs" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT,
    "refId" TEXT,
    "status" TEXT,
    "dueAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_journey_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_affiliates" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT,
    "refId" TEXT,
    "status" TEXT,
    "dueAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_affiliates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_attributions" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT,
    "refId" TEXT,
    "status" TEXT,
    "dueAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_attributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_postbacks" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT,
    "refId" TEXT,
    "status" TEXT,
    "dueAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_postbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_consents" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT,
    "refId" TEXT,
    "status" TEXT,
    "dueAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_send_logs" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT,
    "refId" TEXT,
    "status" TEXT,
    "dueAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_send_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_inbox_messages" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT,
    "refId" TEXT,
    "status" TEXT,
    "dueAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_inbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_push_subscriptions" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT,
    "refId" TEXT,
    "status" TEXT,
    "dueAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_player_states" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT,
    "refId" TEXT,
    "status" TEXT,
    "dueAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_player_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gami_records" (
    "collection" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "playerId" TEXT,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gami_records_pkey" PRIMARY KEY ("collection","operatorId","id")
);

-- CreateTable
CREATE TABLE "bo_day_kpis" (
    "operatorId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "registrations" INTEGER NOT NULL DEFAULT 0,
    "logins" INTEGER NOT NULL DEFAULT 0,
    "activePlayers" INTEGER NOT NULL DEFAULT 0,
    "depositors" INTEGER NOT NULL DEFAULT 0,
    "bettors" INTEGER NOT NULL DEFAULT 0,
    "ftdCount" INTEGER NOT NULL DEFAULT 0,
    "ftdAmount" BIGINT NOT NULL DEFAULT 0,
    "depositsCount" INTEGER NOT NULL DEFAULT 0,
    "depositsAmount" BIGINT NOT NULL DEFAULT 0,
    "withdrawalsCount" INTEGER NOT NULL DEFAULT 0,
    "withdrawalsAmount" BIGINT NOT NULL DEFAULT 0,
    "betCount" INTEGER NOT NULL DEFAULT 0,
    "stakePlaced" BIGINT NOT NULL DEFAULT 0,
    "settledCount" INTEGER NOT NULL DEFAULT 0,
    "settledStake" BIGINT NOT NULL DEFAULT 0,
    "settledWins" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bo_day_kpis_pkey" PRIMARY KEY ("operatorId","day")
);

-- CreateTable
CREATE TABLE "bo_player_days" (
    "operatorId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "depositor" BOOLEAN NOT NULL DEFAULT false,
    "bettor" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "bo_player_days_pkey" PRIMARY KEY ("operatorId","day","playerId")
);

-- CreateTable
CREATE TABLE "bo_players" (
    "operatorId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "registeredDay" TEXT,
    "firstDepositDay" TEXT,

    CONSTRAINT "bo_players_pkey" PRIMARY KEY ("operatorId","playerId")
);

-- CreateTable
CREATE TABLE "bo_processed_events" (
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bo_processed_events_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "bo_skins" (
    "operatorId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bo_skins_pkey" PRIMARY KEY ("operatorId")
);

-- CreateIndex
CREATE INDEX "hub_games_category_status_idx" ON "hub_games"("category", "status");

-- CreateIndex
CREATE UNIQUE INDEX "hub_games_providerId_externalId_key" ON "hub_games"("providerId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "hub_sessions_token_key" ON "hub_sessions"("token");

-- CreateIndex
CREATE INDEX "hub_sessions_operatorId_playerId_idx" ON "hub_sessions"("operatorId", "playerId");

-- CreateIndex
CREATE INDEX "hub_rounds_createdAt_providerId_idx" ON "hub_rounds"("createdAt", "providerId");

-- CreateIndex
CREATE INDEX "hub_rounds_operatorId_createdAt_idx" ON "hub_rounds"("operatorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "hub_rounds_providerId_providerRoundId_key" ON "hub_rounds"("providerId", "providerRoundId");

-- CreateIndex
CREATE INDEX "hub_transactions_operatorId_playerId_createdAt_idx" ON "hub_transactions"("operatorId", "playerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "hub_transactions_providerId_providerTxId_key" ON "hub_transactions"("providerId", "providerTxId");

-- CreateIndex
CREATE INDEX "studio_rounds_operatorId_playerId_createdAt_idx" ON "studio_rounds"("operatorId", "playerId", "createdAt");

-- CreateIndex
CREATE INDEX "studio_rounds_operatorId_playerId_gameId_status_idx" ON "studio_rounds"("operatorId", "playerId", "gameId", "status");

-- CreateIndex
CREATE INDEX "studio_rounds_seedPairId_idx" ON "studio_rounds"("seedPairId");

-- CreateIndex
CREATE INDEX "studio_seed_pairs_operatorId_playerId_active_idx" ON "studio_seed_pairs"("operatorId", "playerId", "active");

-- CreateIndex
CREATE INDEX "promo_bonus_templates_operatorId_type_status_idx" ON "promo_bonus_templates"("operatorId", "type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "promo_bonus_templates_operatorId_code_key" ON "promo_bonus_templates"("operatorId", "code");

-- CreateIndex
CREATE INDEX "promo_code_redemptions_templateId_playerId_idx" ON "promo_code_redemptions"("templateId", "playerId");

-- CreateIndex
CREATE INDEX "promo_player_bonuses_operatorId_playerId_status_idx" ON "promo_player_bonuses"("operatorId", "playerId", "status");

-- CreateIndex
CREATE INDEX "promo_player_bonuses_status_expiresAt_idx" ON "promo_player_bonuses"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "promo_player_bonuses_operatorId_sourceRef_key" ON "promo_player_bonuses"("operatorId", "sourceRef");

-- CreateIndex
CREATE INDEX "promo_settled_rounds_operatorId_currency_settledAt_idx" ON "promo_settled_rounds"("operatorId", "currency", "settledAt");

-- CreateIndex
CREATE INDEX "promo_jackpots_operatorId_status_idx" ON "promo_jackpots"("operatorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "promo_jackpot_levels_jackpotId_key_key" ON "promo_jackpot_levels"("jackpotId", "key");

-- CreateIndex
CREATE INDEX "promo_jackpot_contributions_jackpotId_createdAt_idx" ON "promo_jackpot_contributions"("jackpotId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "promo_jackpot_contributions_jackpotId_roundId_key" ON "promo_jackpot_contributions"("jackpotId", "roundId");

-- CreateIndex
CREATE INDEX "promo_jackpot_seed_funding_jackpotId_idx" ON "promo_jackpot_seed_funding"("jackpotId");

-- CreateIndex
CREATE INDEX "promo_jackpot_wins_status_idx" ON "promo_jackpot_wins"("status");

-- CreateIndex
CREATE UNIQUE INDEX "promo_jackpot_wins_jackpotId_levelKey_roundId_key" ON "promo_jackpot_wins"("jackpotId", "levelKey", "roundId");

-- CreateIndex
CREATE INDEX "promo_drop_campaigns_operatorId_status_idx" ON "promo_drop_campaigns"("operatorId", "status");

-- CreateIndex
CREATE INDEX "promo_drop_prizes_campaignId_idx" ON "promo_drop_prizes"("campaignId");

-- CreateIndex
CREATE INDEX "promo_drop_awards_status_idx" ON "promo_drop_awards"("status");

-- CreateIndex
CREATE UNIQUE INDEX "promo_drop_awards_campaignId_roundId_key" ON "promo_drop_awards"("campaignId", "roundId");

-- CreateIndex
CREATE INDEX "crm_player_profiles_operatorId_lastActivityAt_idx" ON "crm_player_profiles"("operatorId", "lastActivityAt");

-- CreateIndex
CREATE UNIQUE INDEX "crm_player_profiles_operatorId_playerId_key" ON "crm_player_profiles"("operatorId", "playerId");

-- CreateIndex
CREATE INDEX "crm_notes_operatorId_playerId_createdAt_idx" ON "crm_notes"("operatorId", "playerId", "createdAt");

-- CreateIndex
CREATE INDEX "crm_timeline_entries_operatorId_playerId_at_idx" ON "crm_timeline_entries"("operatorId", "playerId", "at");

-- CreateIndex
CREATE INDEX "crm_tickets_operatorId_status_createdAt_idx" ON "crm_tickets"("operatorId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "crm_tickets_operatorId_playerId_idx" ON "crm_tickets"("operatorId", "playerId");

-- CreateIndex
CREATE INDEX "crm_segments_operatorId_idx" ON "crm_segments"("operatorId");

-- CreateIndex
CREATE INDEX "mkt_operator_brands_operatorId_idx" ON "mkt_operator_brands"("operatorId");

-- CreateIndex
CREATE INDEX "mkt_operator_brands_operatorId_playerId_idx" ON "mkt_operator_brands"("operatorId", "playerId");

-- CreateIndex
CREATE INDEX "mkt_operator_brands_operatorId_refId_idx" ON "mkt_operator_brands"("operatorId", "refId");

-- CreateIndex
CREATE INDEX "mkt_operator_brands_status_dueAt_idx" ON "mkt_operator_brands"("status", "dueAt");

-- CreateIndex
CREATE INDEX "mkt_templates_operatorId_idx" ON "mkt_templates"("operatorId");

-- CreateIndex
CREATE INDEX "mkt_templates_operatorId_playerId_idx" ON "mkt_templates"("operatorId", "playerId");

-- CreateIndex
CREATE INDEX "mkt_templates_operatorId_refId_idx" ON "mkt_templates"("operatorId", "refId");

-- CreateIndex
CREATE INDEX "mkt_templates_status_dueAt_idx" ON "mkt_templates"("status", "dueAt");

-- CreateIndex
CREATE INDEX "mkt_campaigns_operatorId_idx" ON "mkt_campaigns"("operatorId");

-- CreateIndex
CREATE INDEX "mkt_campaigns_operatorId_playerId_idx" ON "mkt_campaigns"("operatorId", "playerId");

-- CreateIndex
CREATE INDEX "mkt_campaigns_operatorId_refId_idx" ON "mkt_campaigns"("operatorId", "refId");

-- CreateIndex
CREATE INDEX "mkt_campaigns_status_dueAt_idx" ON "mkt_campaigns"("status", "dueAt");

-- CreateIndex
CREATE INDEX "mkt_journeys_operatorId_idx" ON "mkt_journeys"("operatorId");

-- CreateIndex
CREATE INDEX "mkt_journeys_operatorId_playerId_idx" ON "mkt_journeys"("operatorId", "playerId");

-- CreateIndex
CREATE INDEX "mkt_journeys_operatorId_refId_idx" ON "mkt_journeys"("operatorId", "refId");

-- CreateIndex
CREATE INDEX "mkt_journeys_status_dueAt_idx" ON "mkt_journeys"("status", "dueAt");

-- CreateIndex
CREATE INDEX "mkt_journey_runs_operatorId_idx" ON "mkt_journey_runs"("operatorId");

-- CreateIndex
CREATE INDEX "mkt_journey_runs_operatorId_playerId_idx" ON "mkt_journey_runs"("operatorId", "playerId");

-- CreateIndex
CREATE INDEX "mkt_journey_runs_operatorId_refId_idx" ON "mkt_journey_runs"("operatorId", "refId");

-- CreateIndex
CREATE INDEX "mkt_journey_runs_status_dueAt_idx" ON "mkt_journey_runs"("status", "dueAt");

-- CreateIndex
CREATE INDEX "mkt_affiliates_operatorId_idx" ON "mkt_affiliates"("operatorId");

-- CreateIndex
CREATE INDEX "mkt_affiliates_operatorId_playerId_idx" ON "mkt_affiliates"("operatorId", "playerId");

-- CreateIndex
CREATE INDEX "mkt_affiliates_operatorId_refId_idx" ON "mkt_affiliates"("operatorId", "refId");

-- CreateIndex
CREATE INDEX "mkt_affiliates_status_dueAt_idx" ON "mkt_affiliates"("status", "dueAt");

-- CreateIndex
CREATE INDEX "mkt_attributions_operatorId_idx" ON "mkt_attributions"("operatorId");

-- CreateIndex
CREATE INDEX "mkt_attributions_operatorId_playerId_idx" ON "mkt_attributions"("operatorId", "playerId");

-- CreateIndex
CREATE INDEX "mkt_attributions_operatorId_refId_idx" ON "mkt_attributions"("operatorId", "refId");

-- CreateIndex
CREATE INDEX "mkt_attributions_status_dueAt_idx" ON "mkt_attributions"("status", "dueAt");

-- CreateIndex
CREATE INDEX "mkt_postbacks_operatorId_idx" ON "mkt_postbacks"("operatorId");

-- CreateIndex
CREATE INDEX "mkt_postbacks_operatorId_playerId_idx" ON "mkt_postbacks"("operatorId", "playerId");

-- CreateIndex
CREATE INDEX "mkt_postbacks_operatorId_refId_idx" ON "mkt_postbacks"("operatorId", "refId");

-- CreateIndex
CREATE INDEX "mkt_postbacks_status_dueAt_idx" ON "mkt_postbacks"("status", "dueAt");

-- CreateIndex
CREATE INDEX "mkt_consents_operatorId_idx" ON "mkt_consents"("operatorId");

-- CreateIndex
CREATE INDEX "mkt_consents_operatorId_playerId_idx" ON "mkt_consents"("operatorId", "playerId");

-- CreateIndex
CREATE INDEX "mkt_consents_operatorId_refId_idx" ON "mkt_consents"("operatorId", "refId");

-- CreateIndex
CREATE INDEX "mkt_consents_status_dueAt_idx" ON "mkt_consents"("status", "dueAt");

-- CreateIndex
CREATE INDEX "mkt_send_logs_operatorId_idx" ON "mkt_send_logs"("operatorId");

-- CreateIndex
CREATE INDEX "mkt_send_logs_operatorId_playerId_idx" ON "mkt_send_logs"("operatorId", "playerId");

-- CreateIndex
CREATE INDEX "mkt_send_logs_operatorId_refId_idx" ON "mkt_send_logs"("operatorId", "refId");

-- CreateIndex
CREATE INDEX "mkt_send_logs_status_dueAt_idx" ON "mkt_send_logs"("status", "dueAt");

-- CreateIndex
CREATE INDEX "mkt_inbox_messages_operatorId_idx" ON "mkt_inbox_messages"("operatorId");

-- CreateIndex
CREATE INDEX "mkt_inbox_messages_operatorId_playerId_idx" ON "mkt_inbox_messages"("operatorId", "playerId");

-- CreateIndex
CREATE INDEX "mkt_inbox_messages_operatorId_refId_idx" ON "mkt_inbox_messages"("operatorId", "refId");

-- CreateIndex
CREATE INDEX "mkt_inbox_messages_status_dueAt_idx" ON "mkt_inbox_messages"("status", "dueAt");

-- CreateIndex
CREATE INDEX "mkt_push_subscriptions_operatorId_idx" ON "mkt_push_subscriptions"("operatorId");

-- CreateIndex
CREATE INDEX "mkt_push_subscriptions_operatorId_playerId_idx" ON "mkt_push_subscriptions"("operatorId", "playerId");

-- CreateIndex
CREATE INDEX "mkt_push_subscriptions_operatorId_refId_idx" ON "mkt_push_subscriptions"("operatorId", "refId");

-- CreateIndex
CREATE INDEX "mkt_push_subscriptions_status_dueAt_idx" ON "mkt_push_subscriptions"("status", "dueAt");

-- CreateIndex
CREATE INDEX "mkt_player_states_operatorId_idx" ON "mkt_player_states"("operatorId");

-- CreateIndex
CREATE INDEX "mkt_player_states_operatorId_playerId_idx" ON "mkt_player_states"("operatorId", "playerId");

-- CreateIndex
CREATE INDEX "mkt_player_states_operatorId_refId_idx" ON "mkt_player_states"("operatorId", "refId");

-- CreateIndex
CREATE INDEX "mkt_player_states_status_dueAt_idx" ON "mkt_player_states"("status", "dueAt");

-- CreateIndex
CREATE INDEX "gami_records_collection_operatorId_playerId_idx" ON "gami_records"("collection", "operatorId", "playerId");

-- CreateIndex
CREATE INDEX "gami_records_collection_updatedAt_idx" ON "gami_records"("collection", "updatedAt");

-- CreateIndex
CREATE INDEX "bo_player_days_operatorId_playerId_idx" ON "bo_player_days"("operatorId", "playerId");

-- CreateIndex
CREATE INDEX "bo_players_operatorId_registeredDay_idx" ON "bo_players"("operatorId", "registeredDay");

-- AddForeignKey
ALTER TABLE "hub_games" ADD CONSTRAINT "hub_games_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "hub_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_code_redemptions" ADD CONSTRAINT "promo_code_redemptions_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "promo_bonus_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_bonus_rounds" ADD CONSTRAINT "promo_bonus_rounds_bonusId_fkey" FOREIGN KEY ("bonusId") REFERENCES "promo_player_bonuses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_jackpot_levels" ADD CONSTRAINT "promo_jackpot_levels_jackpotId_fkey" FOREIGN KEY ("jackpotId") REFERENCES "promo_jackpots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_drop_prizes" ADD CONSTRAINT "promo_drop_prizes_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "promo_drop_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

