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
import { ProgressController } from './progress.controller';
import { ProgressService } from './progress.service';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  controllers: [
    NoticesController,
    CoursesController,
    AssignmentsController,
    PastQuestionsController,
    AdminController,
    AttendanceController,
    CalendarController,
    ProgressController,
    SearchController,
    PushController,
  ],
  providers: [
    NoticesService,
    CoursesService,
    AssignmentsService,
    PastQuestionsService,
    AdminService,
    AttendanceService,
    CalendarService,
    ProgressService,
    SearchService,
    PushService,
  ],
})
export class DomainModule {}
