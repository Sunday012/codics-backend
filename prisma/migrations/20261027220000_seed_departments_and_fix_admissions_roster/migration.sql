-- AlterTable AdmissionsRoster to include phone and source fields
ALTER TABLE "AdmissionsRoster" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "AdmissionsRoster" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'admin_import';

-- Insert or update foundational faculty departments
INSERT INTO "Department" ("id", "code", "name", "createdAt", "updatedAt")
VALUES 
  ('dept-csc', 'CSC', 'Computer Science', NOW(), NOW()),
  ('dept-sen', 'SEN', 'Software Engineering', NOW(), NOW()),
  ('dept-cyb', 'CYB', 'Cyber Security', NOW(), NOW()),
  ('dept-it',  'IFT', 'Information Technology', NOW(), NOW())
ON CONFLICT ("code") DO UPDATE 
  SET "name" = EXCLUDED."name", "updatedAt" = NOW();

-- Ensure academic setting exists
INSERT INTO "Setting" ("id", "session", "semester", "updatedAt")
SELECT 'setting-default', '2026/2027', 'first', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Setting");
