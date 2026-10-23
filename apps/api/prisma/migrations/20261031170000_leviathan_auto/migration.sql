-- Concursos automáticos de Leviathan.
CREATE TABLE "lev_settings" (
    "operatorId" TEXT NOT NULL,
    "autoEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoEntry" BIGINT NOT NULL DEFAULT 0,
    "autoDurationMin" INTEGER NOT NULL DEFAULT 360,
    "autoLeadMin" INTEGER NOT NULL DEFAULT 60,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "lev_settings_pkey" PRIMARY KEY ("operatorId"),
    CONSTRAINT "lev_settings_values" CHECK ("autoEntry" >= 0 AND "autoDurationMin" BETWEEN 60 AND 2880 AND "autoLeadMin" BETWEEN 5 AND 1440)
);
