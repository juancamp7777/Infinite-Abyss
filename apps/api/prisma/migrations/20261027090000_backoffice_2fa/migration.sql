-- AlterTable
ALTER TABLE "BackofficeUser" ADD COLUMN     "totpEnabledAt" TIMESTAMP(3),
ADD COLUMN     "totpLastStep" INTEGER,
ADD COLUMN     "totpPendingEnc" TEXT,
ADD COLUMN     "totpRecovery" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "totpSecretEnc" TEXT;

