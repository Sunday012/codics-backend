-- CreateTable
CREATE TABLE "AcademicPeriod" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "start" TEXT NOT NULL,
    "end" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademicPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetableSlot" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'lecture',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimetableSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetableException" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "newVenue" TEXT,
    "newTime" TEXT,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimetableException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarEvent" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "location" TEXT,
    "courseId" TEXT,
    "courseCode" TEXT,
    "scope" "AudienceScope" NOT NULL DEFAULT 'faculty',
    "targetDepartment" TEXT,
    "targetLevel" INTEGER,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AcademicPeriod_sessionId_idx" ON "AcademicPeriod"("sessionId");
CREATE INDEX "AcademicPeriod_type_idx" ON "AcademicPeriod"("type");
CREATE INDEX "AcademicPeriod_start_end_idx" ON "AcademicPeriod"("start", "end");

-- CreateIndex
CREATE INDEX "TimetableSlot_offeringId_idx" ON "TimetableSlot"("offeringId");
CREATE INDEX "TimetableSlot_weekday_idx" ON "TimetableSlot"("weekday");

-- CreateIndex
CREATE INDEX "TimetableException_slotId_idx" ON "TimetableException"("slotId");
CREATE INDEX "TimetableException_date_idx" ON "TimetableException"("date");
CREATE INDEX "TimetableException_createdBy_idx" ON "TimetableException"("createdBy");

-- CreateIndex
CREATE INDEX "CalendarEvent_start_end_idx" ON "CalendarEvent"("start", "end");
CREATE INDEX "CalendarEvent_scope_idx" ON "CalendarEvent"("scope");
CREATE INDEX "CalendarEvent_type_idx" ON "CalendarEvent"("type");
CREATE INDEX "CalendarEvent_courseCode_idx" ON "CalendarEvent"("courseCode");
CREATE INDEX "CalendarEvent_targetDepartment_idx" ON "CalendarEvent"("targetDepartment");
CREATE INDEX "CalendarEvent_targetLevel_idx" ON "CalendarEvent"("targetLevel");
CREATE INDEX "CalendarEvent_createdBy_idx" ON "CalendarEvent"("createdBy");

-- AddForeignKey
ALTER TABLE "TimetableSlot" ADD CONSTRAINT "TimetableSlot_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "Offering"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableException" ADD CONSTRAINT "TimetableException_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "TimetableSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableException" ADD CONSTRAINT "TimetableException_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
