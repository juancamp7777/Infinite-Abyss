-- Id de sesión del proveedor (agregadores como API-Matic/API-Slots identifican la sesión con su propio id).
-- AlterTable
ALTER TABLE "hub_sessions" ADD COLUMN     "externalSessionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "hub_sessions_providerId_externalSessionId_key" ON "hub_sessions"("providerId", "externalSessionId");
