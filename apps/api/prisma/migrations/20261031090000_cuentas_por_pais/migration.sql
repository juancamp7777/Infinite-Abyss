-- Cuentas de cobro por país: país del método y documento del titular (cédula, RFC, CUIT).
ALTER TABLE "pearl_bank_accounts" ADD COLUMN "country" TEXT, ADD COLUMN "holderDocument" TEXT;
