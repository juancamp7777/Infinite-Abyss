-- Leviathan: concursos de fichas sobre deportes (BetBattle). Pozo cerrado, comisión 5 %, reparto por resto mayor.
-- CreateTable
CREATE TABLE "lev_events" (
    "id" UUID NOT NULL,
    "sport" TEXT NOT NULL,
    "league" TEXT NOT NULL,
    "home" TEXT NOT NULL,
    "away" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "homeScore" INTEGER,
    "awayScore" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'sim',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lev_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lev_selections" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "market" TEXT NOT NULL,
    "line" TEXT,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "oddsE2" INTEGER NOT NULL,
    "result" TEXT NOT NULL DEFAULT 'OPEN',

    CONSTRAINT "lev_selections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lev_games" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "entry" BIGINT NOT NULL,
    "rakePpm" INTEGER NOT NULL,
    "curve" TEXT NOT NULL,
    "minBets" INTEGER NOT NULL,
    "maxBets" INTEGER NOT NULL,
    "minPlayers" INTEGER NOT NULL,
    "maxPlayers" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "roomCode" TEXT,
    "createdBy" TEXT,
    "entriesCloseAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "pot" BIGINT NOT NULL DEFAULT 0,
    "rake" BIGINT,
    "pool" BIGINT,
    "residue" BIGINT,
    "cancelReason" TEXT,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lev_games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lev_game_events" (
    "gameId" UUID NOT NULL,
    "eventId" UUID NOT NULL,

    CONSTRAINT "lev_game_events_pkey" PRIMARY KEY ("gameId","eventId")
);

-- CreateTable
CREATE TABLE "lev_entries" (
    "id" UUID NOT NULL,
    "gameId" UUID NOT NULL,
    "playerId" TEXT NOT NULL,
    "chips" BIGINT NOT NULL,
    "bets" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rank" INTEGER,
    "qualified" BOOLEAN,
    "prize" BIGINT,

    CONSTRAINT "lev_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lev_bets" (
    "id" UUID NOT NULL,
    "gameId" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "selectionId" UUID NOT NULL,
    "stake" BIGINT NOT NULL,
    "oddsE2" INTEGER NOT NULL,
    "returnChips" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lev_bets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lev_events_status_startsAt_idx" ON "lev_events"("status", "startsAt");

-- CreateIndex
CREATE INDEX "lev_selections_eventId_idx" ON "lev_selections"("eventId");

-- CreateIndex
CREATE INDEX "lev_games_operatorId_status_idx" ON "lev_games"("operatorId", "status");

-- CreateIndex
CREATE INDEX "lev_games_status_entriesCloseAt_idx" ON "lev_games"("status", "entriesCloseAt");

-- CreateIndex
CREATE UNIQUE INDEX "lev_entries_gameId_playerId_key" ON "lev_entries"("gameId", "playerId");

-- CreateIndex
CREATE INDEX "lev_bets_selectionId_status_idx" ON "lev_bets"("selectionId", "status");

-- CreateIndex
CREATE INDEX "lev_bets_entryId_idx" ON "lev_bets"("entryId");


-- Reglas que la base protege aunque falle la aplicación.
ALTER TABLE "lev_games" ADD CONSTRAINT "lev_games_status" CHECK ("status" IN ('OPEN','RUNNING','SETTLING','SETTLED','CANCELLED'));
ALTER TABLE "lev_games" ADD CONSTRAINT "lev_games_mode" CHECK ("mode" IN ('QUICK','FRIENDS'));
ALTER TABLE "lev_games" ADD CONSTRAINT "lev_games_amounts" CHECK ("entry" >= 0 AND "pot" >= 0 AND "rakePpm" BETWEEN 0 AND 200000 AND "minBets" >= 0 AND "maxBets" >= "minBets" AND "minPlayers" >= 2 AND "maxPlayers" >= "minPlayers");
ALTER TABLE "lev_games" ADD CONSTRAINT "lev_games_settled_figures" CHECK (("status" = 'SETTLED') = ("rake" IS NOT NULL AND "pool" IS NOT NULL AND "residue" IS NOT NULL AND "settledAt" IS NOT NULL));
ALTER TABLE "lev_games" ADD CONSTRAINT "lev_games_pot_conserves" CHECK ("rake" IS NULL OR "rake" + "pool" + "residue" = "pot");
CREATE UNIQUE INDEX "lev_games_open_room_code" ON "lev_games" ("roomCode") WHERE "roomCode" IS NOT NULL AND "status" IN ('OPEN','RUNNING');
ALTER TABLE "lev_entries" ADD CONSTRAINT "lev_entries_chips" CHECK ("chips" >= 0 AND "bets" >= 0 AND ("prize" IS NULL OR "prize" >= 0));
ALTER TABLE "lev_bets" ADD CONSTRAINT "lev_bets_values" CHECK ("stake" > 0 AND "oddsE2" BETWEEN 101 AND 100000 AND "returnChips" >= "stake" AND "status" IN ('OPEN','WON','LOST','VOID'));
ALTER TABLE "lev_selections" ADD CONSTRAINT "lev_selections_values" CHECK ("oddsE2" BETWEEN 101 AND 100000 AND "result" IN ('OPEN','WON','LOST','VOID'));
