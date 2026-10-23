-- Partidos reales de API-Football: id del proveedor, único por fuente.
ALTER TABLE "lev_events" ADD COLUMN "externalId" TEXT;
CREATE UNIQUE INDEX "lev_events_source_externalId_key" ON "lev_events"("source", "externalId");
