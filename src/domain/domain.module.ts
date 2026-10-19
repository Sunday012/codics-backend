import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';
import { NoticesController } from './notices.controller';
import { NoticesService } from './notices.service';
import { PastQuestionsController } from './past-questions.controller';
import { PastQuestionsService } from './past-questions.service';

@Module({
  controllers: [
    NoticesController,
    CoursesController,
    AssignmentsController,
    PastQuestionsController,
    AdminController,
    AttendanceController,
    CalendarController,
  ],
  providers: [
    NoticesService,
    CoursesService,
    AssignmentsService,
    PastQuestionsService,
    AdminService,
    AttendanceService,
    CalendarService,
  ],
})
export class DomainModule {}
