-- Tasas de cambio por moneda (moneda del casino por 1 unidad).
ALTER TABLE "pearl_settings" ADD COLUMN "fxRates" JSONB;
