-- Depósitos USDT vía Binance: tasa del operador, llave cifrada del feed y monto original del depósito.
ALTER TABLE "pearl_settings" ADD COLUMN "usdtRate" TEXT;
ALTER TABLE "pearl_feeds" ADD COLUMN "secretEnc" TEXT, ADD COLUMN "polledAt" TIMESTAMP(3);
ALTER TABLE "pearl_bank_txs" ADD COLUMN "asset" TEXT, ADD COLUMN "assetAmount" TEXT;
