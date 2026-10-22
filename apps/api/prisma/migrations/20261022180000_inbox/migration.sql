-- CreateTable
CREATE TABLE "inbox_conversations" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "playerId" TEXT,
    "contactName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "assigneeId" TEXT,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "lastMessagePreview" TEXT NOT NULL DEFAULT '',
    "unread" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbox_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox_messages" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "authorType" TEXT NOT NULL,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "clientMsgId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox_quick_replies" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "shortcut" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_quick_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox_visitors" (
    "id" UUID NOT NULL,
    "operatorId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_visitors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inbox_conversations_operatorId_status_lastMessageAt_idx" ON "inbox_conversations"("operatorId", "status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "inbox_conversations_operatorId_channel_externalId_idx" ON "inbox_conversations"("operatorId", "channel", "externalId");

-- CreateIndex
CREATE INDEX "inbox_conversations_operatorId_assigneeId_idx" ON "inbox_conversations"("operatorId", "assigneeId");

-- CreateIndex
CREATE INDEX "inbox_messages_conversationId_createdAt_idx" ON "inbox_messages"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "inbox_messages_conversationId_clientMsgId_key" ON "inbox_messages"("conversationId", "clientMsgId");

-- CreateIndex
CREATE UNIQUE INDEX "inbox_quick_replies_operatorId_shortcut_key" ON "inbox_quick_replies"("operatorId", "shortcut");

-- CreateIndex
CREATE UNIQUE INDEX "inbox_visitors_tokenHash_key" ON "inbox_visitors"("tokenHash");

-- CreateIndex
CREATE INDEX "inbox_visitors_operatorId_idx" ON "inbox_visitors"("operatorId");

