import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';
import { NoticesController } from './notices.controller';
import { NoticesService } from './notices.service';
import { PastQuestionsController } from './past-questions.controller';
import { PastQuestionsService } from './past-questions.service';

@Module({
  controllers: [NoticesController, CoursesController, AssignmentsController, PastQuestionsController, AdminController],
  providers: [NoticesService, CoursesService, AssignmentsService, PastQuestionsService, AdminService],
})
export class DomainModule {}
