-- CreateTable
CREATE TABLE "integration_credentials" (
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "secretsEnc" TEXT,
    "publicFields" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'saved',
    "lastError" TEXT,
    "lastTestAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_credentials_pkey" PRIMARY KEY ("scope","key")
);

