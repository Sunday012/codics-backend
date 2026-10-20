-- CreateEnum
CREATE TYPE "FileCategory" AS ENUM ('course_material', 'assignment_submission', 'past_question');

-- AlterTable: Add metadata columns to Material
ALTER TABLE "Material"
  ADD COLUMN IF NOT EXISTS "mimeType" TEXT,
  ADD COLUMN IF NOT EXISTS "sha256" TEXT,
  ADD COLUMN IF NOT EXISTS "uploaderId" TEXT;

-- CreateTable: StoredFile
CREATE TABLE IF NOT EXISTS "StoredFile" (
    "id" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "category" "FileCategory" NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "linkedRecordId" TEXT,
    "storageDriver" TEXT NOT NULL DEFAULT 'disk',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoredFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "StoredFile_fileKey_key" ON "StoredFile"("fileKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StoredFile_category_idx" ON "StoredFile"("category");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StoredFile_uploaderId_idx" ON "StoredFile"("uploaderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StoredFile_linkedRecordId_idx" ON "StoredFile"("linkedRecordId");

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
