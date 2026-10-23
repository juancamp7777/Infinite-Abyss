-- AlterTable
ALTER TABLE "User" ADD COLUMN "ageDeclaredAt" TIMESTAMP(3);

-- El formulario web siempre exigió la casilla de 18+: quienes se registraron por ahí ya declararon su edad.
-- Las cuentas creadas desde el chat (@leads.invalid) y las demo no la tienen.
UPDATE "User" SET "ageDeclaredAt" = "createdAt"
WHERE "ageDeclaredAt" IS NULL AND "isDemo" = false AND "emailNormalized" NOT LIKE '%@leads.invalid';
