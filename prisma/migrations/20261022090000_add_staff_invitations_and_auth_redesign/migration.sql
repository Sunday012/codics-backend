-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AuthProvider') THEN
    CREATE TYPE "AuthProvider" AS ENUM ('local', 'google', 'google_linked');
  END IF;
END $$;

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StaffInvitationStatus') THEN
    CREATE TYPE "StaffInvitationStatus" AS ENUM ('pending', 'accepted', 'expired', 'revoked');
  END IF;
END $$;

-- AlterTable User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "authProvider" "AuthProvider" NOT NULL DEFAULT 'local';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "baseRole" "Role" NOT NULL DEFAULT 'student';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "googleEmail" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "googleId" TEXT;

-- Safely preserve actual underlying roles for existing users (Phase 12.1 Follow-up Check 1)
UPDATE "User" SET "baseRole" = 'lecturer' WHERE "role" IN ('lecturer', 'hod') OR "staffId" IS NOT NULL;
UPDATE "User" SET "baseRole" = 'admin' WHERE "role" = 'admin' AND "staffId" IS NULL;
UPDATE "User" SET "baseRole" = 'student' WHERE "role" IN ('student', 'course_rep');

-- CreateTable StaffInvitation
CREATE TABLE IF NOT EXISTS "StaffInvitation" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "departmentId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "status" "StaffInvitationStatus" NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable AdmissionsRoster
CREATE TABLE IF NOT EXISTS "AdmissionsRoster" (
    "id" TEXT NOT NULL,
    "jambRegNo" TEXT NOT NULL,
    "matricNo" TEXT,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "departmentCode" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 100,
    "session" TEXT NOT NULL,
    "verificationKey" TEXT NOT NULL,
    "isClaimed" BOOLEAN NOT NULL DEFAULT false,
    "claimedAt" TIMESTAMP(3),
    "claimedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdmissionsRoster_pkey" PRIMARY KEY ("id")
);

-- Indexes for StaffInvitation
CREATE UNIQUE INDEX IF NOT EXISTS "StaffInvitation_tokenHash_key" ON "StaffInvitation"("tokenHash");
CREATE UNIQUE INDEX IF NOT EXISTS "StaffInvitation_acceptedById_key" ON "StaffInvitation"("acceptedById");
CREATE INDEX IF NOT EXISTS "StaffInvitation_email_idx" ON "StaffInvitation"("email");
CREATE INDEX IF NOT EXISTS "StaffInvitation_tokenHash_idx" ON "StaffInvitation"("tokenHash");
CREATE INDEX IF NOT EXISTS "StaffInvitation_departmentId_idx" ON "StaffInvitation"("departmentId");
CREATE INDEX IF NOT EXISTS "StaffInvitation_status_idx" ON "StaffInvitation"("status");

-- Indexes for AdmissionsRoster
CREATE UNIQUE INDEX IF NOT EXISTS "AdmissionsRoster_jambRegNo_key" ON "AdmissionsRoster"("jambRegNo");
CREATE UNIQUE INDEX IF NOT EXISTS "AdmissionsRoster_matricNo_key" ON "AdmissionsRoster"("matricNo");
CREATE UNIQUE INDEX IF NOT EXISTS "AdmissionsRoster_claimedByUserId_key" ON "AdmissionsRoster"("claimedByUserId");
CREATE INDEX IF NOT EXISTS "AdmissionsRoster_jambRegNo_idx" ON "AdmissionsRoster"("jambRegNo");
CREATE INDEX IF NOT EXISTS "AdmissionsRoster_matricNo_idx" ON "AdmissionsRoster"("matricNo");
CREATE INDEX IF NOT EXISTS "AdmissionsRoster_departmentCode_idx" ON "AdmissionsRoster"("departmentCode");
CREATE INDEX IF NOT EXISTS "AdmissionsRoster_isClaimed_idx" ON "AdmissionsRoster"("isClaimed");

-- Index for User Google ID
CREATE UNIQUE INDEX IF NOT EXISTS "User_googleId_key" ON "User"("googleId");

-- Foreign Keys for StaffInvitation
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StaffInvitation_departmentId_fkey') THEN
    ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StaffInvitation_invitedById_fkey') THEN
    ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StaffInvitation_acceptedById_fkey') THEN
    ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Row Level Security and Revoke Safeguards
ALTER TABLE "StaffInvitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdmissionsRoster" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "StaffInvitation" FROM anon;
    REVOKE ALL ON "AdmissionsRoster" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "StaffInvitation" FROM authenticated;
    REVOKE ALL ON "AdmissionsRoster" FROM authenticated;
  END IF;
END $$;
