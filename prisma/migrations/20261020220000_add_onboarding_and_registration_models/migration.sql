-- AlterEnum
ALTER TYPE "FileCategory" ADD VALUE IF NOT EXISTS 'onboarding_document';

-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('draft', 'submitted', 'under_review', 'action_required', 'verified', 'rejected', 'matriculated');

-- CreateEnum
CREATE TYPE "OnboardingDocType" AS ENUM ('jamb_result', 'o_level', 'birth_certificate', 'lga_identification', 'admission_letter', 'other');

-- CreateEnum
CREATE TYPE "DocReviewStatus" AS ENUM ('pending', 'verified', 'rejected');

-- CreateTable: OnboardingApplication
CREATE TABLE "OnboardingApplication" (
    "id" TEXT NOT NULL,
    "applicationNumber" TEXT NOT NULL,
    "jambRegNo" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "departmentId" TEXT NOT NULL,
    "entryLevel" INTEGER NOT NULL DEFAULT 100,
    "session" TEXT NOT NULL,
    "status" "OnboardingStatus" NOT NULL DEFAULT 'draft',
    "actionRequiredReason" TEXT,
    "rejectionReason" TEXT,
    "accessKeyHash" TEXT NOT NULL,
    "convertedUserId" TEXT,
    "convertedMatricNo" TEXT,
    "convertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable: OnboardingDocument
CREATE TABLE "OnboardingDocument" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "documentType" "OnboardingDocType" NOT NULL,
    "title" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "status" "DocReviewStatus" NOT NULL DEFAULT 'pending',
    "reviewNotes" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable: OnboardingReviewLog
CREATE TABLE "OnboardingReviewLog" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "reviewerId" TEXT,
    "fromStatus" "OnboardingStatus" NOT NULL,
    "toStatus" "OnboardingStatus" NOT NULL,
    "action" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OnboardingReviewLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable: RegistrationGuide
CREATE TABLE "RegistrationGuide" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "session" TEXT NOT NULL,
    "targetDepartmentCode" TEXT,
    "steps" JSONB NOT NULL,
    "importantNotice" TEXT,
    "publishedBy" TEXT NOT NULL,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "lastUpdatedDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegistrationGuide_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingApplication_applicationNumber_key" ON "OnboardingApplication"("applicationNumber");
CREATE UNIQUE INDEX "OnboardingApplication_convertedUserId_key" ON "OnboardingApplication"("convertedUserId");
CREATE UNIQUE INDEX "OnboardingApplication_jambRegNo_session_key" ON "OnboardingApplication"("jambRegNo", "session");
CREATE INDEX "OnboardingApplication_jambRegNo_idx" ON "OnboardingApplication"("jambRegNo");
CREATE INDEX "OnboardingApplication_email_idx" ON "OnboardingApplication"("email");
CREATE INDEX "OnboardingApplication_departmentId_idx" ON "OnboardingApplication"("departmentId");
CREATE INDEX "OnboardingApplication_status_idx" ON "OnboardingApplication"("status");
CREATE INDEX "OnboardingApplication_session_idx" ON "OnboardingApplication"("session");

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingDocument_fileKey_key" ON "OnboardingDocument"("fileKey");
CREATE UNIQUE INDEX "OnboardingDocument_applicationId_documentType_key" ON "OnboardingDocument"("applicationId", "documentType");
CREATE INDEX "OnboardingDocument_applicationId_idx" ON "OnboardingDocument"("applicationId");
CREATE INDEX "OnboardingDocument_status_idx" ON "OnboardingDocument"("status");
CREATE INDEX "OnboardingDocument_reviewedBy_idx" ON "OnboardingDocument"("reviewedBy");

-- CreateIndex
CREATE INDEX "OnboardingReviewLog_applicationId_idx" ON "OnboardingReviewLog"("applicationId");
CREATE INDEX "OnboardingReviewLog_reviewerId_idx" ON "OnboardingReviewLog"("reviewerId");
CREATE INDEX "OnboardingReviewLog_createdAt_idx" ON "OnboardingReviewLog"("createdAt");

-- CreateIndex
CREATE INDEX "RegistrationGuide_session_idx" ON "RegistrationGuide"("session");
CREATE INDEX "RegistrationGuide_targetDepartmentCode_idx" ON "RegistrationGuide"("targetDepartmentCode");
CREATE INDEX "RegistrationGuide_isPublished_idx" ON "RegistrationGuide"("isPublished");

-- AddForeignKey
ALTER TABLE "OnboardingApplication" ADD CONSTRAINT "OnboardingApplication_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OnboardingApplication" ADD CONSTRAINT "OnboardingApplication_convertedUserId_fkey" FOREIGN KEY ("convertedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingDocument" ADD CONSTRAINT "OnboardingDocument_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "OnboardingApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OnboardingDocument" ADD CONSTRAINT "OnboardingDocument_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingReviewLog" ADD CONSTRAINT "OnboardingReviewLog_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "OnboardingApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OnboardingReviewLog" ADD CONSTRAINT "OnboardingReviewLog_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationGuide" ADD CONSTRAINT "RegistrationGuide_publishedBy_fkey" FOREIGN KEY ("publishedBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
