import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { User } from '../data/entities';
import { CoursesService } from './courses.service';
import { MaterialDto, ModuleDto } from './courses.dto';

@ApiTags('courses') @ApiBearerAuth() @Controller()
export class CoursesController {
  constructor(private courses: CoursesService) {}
  @Get('courses') list(@CurrentUser() user: User, @Query() query: Record<string, string>) { return this.courses.list(user, query); }
  @Get('courses/enrollments/me') enrollments(@CurrentUser() user: User) { return this.courses.enrollments(user); }
  @Get('courses/:id') get(@Param('id') id: string, @Query('session') session?: string) { return this.courses.get(id, session); }
  @Get('offerings/:id') offering(@Param('id') id: string, @CurrentUser() user: User) { return this.courses.offering(id, user); }
  @Roles('lecturer', 'hod', 'admin') @Post('offerings/:id/modules') createModule(@Param('id') id: string, @CurrentUser() user: User, @Body() dto: ModuleDto) { return this.courses.createModule(id, user, dto); }
  @Roles('lecturer', 'hod', 'admin') @Delete('modules/:id') removeModule(@Param('id') id: string, @CurrentUser() user: User) { return this.courses.removeModule(id, user); }
  @Roles('lecturer', 'hod', 'admin') @Post('modules/:id/materials') createMaterial(@Param('id') id: string, @CurrentUser() user: User, @Body() dto: MaterialDto) { return this.courses.createMaterial(id, user, dto); }
  @Roles('lecturer', 'hod', 'admin') @Put('materials/:id') updateMaterial(@Param('id') id: string, @CurrentUser() user: User, @Body() dto: MaterialDto) { return this.courses.updateMaterial(id, user, dto); }
  @Roles('lecturer', 'hod', 'admin') @Patch('materials/:id/status') toggleMaterial(@Param('id') id: string, @CurrentUser() user: User) { return this.courses.toggleMaterial(id, user); }
  @Roles('lecturer', 'hod', 'admin') @Delete('materials/:id') removeMaterial(@Param('id') id: string, @CurrentUser() user: User) { return this.courses.removeMaterial(id, user); }
}
