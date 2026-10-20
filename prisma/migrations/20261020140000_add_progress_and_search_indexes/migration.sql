-- CreateTable: UserMaterialProgress
CREATE TABLE "UserMaterialProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "lastAccessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserMaterialProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserMaterialProgress_userId_materialId_key" ON "UserMaterialProgress"("userId", "materialId");

-- CreateIndex
CREATE INDEX "UserMaterialProgress_userId_lastAccessedAt_idx" ON "UserMaterialProgress"("userId", "lastAccessedAt");

-- CreateIndex
CREATE INDEX "UserMaterialProgress_userId_offeringId_idx" ON "UserMaterialProgress"("userId", "offeringId");

-- CreateIndex
CREATE INDEX "UserMaterialProgress_materialId_idx" ON "UserMaterialProgress"("materialId");

-- AddForeignKey
ALTER TABLE "UserMaterialProgress" ADD CONSTRAINT "UserMaterialProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMaterialProgress" ADD CONSTRAINT "UserMaterialProgress_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMaterialProgress" ADD CONSTRAINT "UserMaterialProgress_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "Offering"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- PostgreSQL Full-Text Search (tsvector) GIN Indexes for Global Search
CREATE INDEX IF NOT EXISTS "Notice_fts_idx" ON "Notice" USING GIN (
    to_tsvector('english', coalesce("title", '') || ' ' || coalesce("body", '') || ' ' || coalesce("targetCourseCode", ''))
);

CREATE INDEX IF NOT EXISTS "Course_fts_idx" ON "Course" USING GIN (
    to_tsvector('english', coalesce("code", '') || ' ' || coalesce("title", ''))
);

CREATE INDEX IF NOT EXISTS "Material_fts_idx" ON "Material" USING GIN (
    to_tsvector('english', coalesce("title", '') || ' ' || coalesce("fileName", '') || ' ' || coalesce("body", ''))
);

CREATE INDEX IF NOT EXISTS "Assignment_fts_idx" ON "Assignment" USING GIN (
    to_tsvector('english', coalesce("title", '') || ' ' || coalesce("instructions", ''))
);

CREATE INDEX IF NOT EXISTS "PastQuestion_fts_idx" ON "PastQuestion" USING GIN (
    to_tsvector('english', coalesce("courseCode", '') || ' ' || coalesce("session", '') || ' ' || coalesce("fileName", ''))
);
