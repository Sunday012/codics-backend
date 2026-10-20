import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { SafeUser } from '../common/user.util';
import { CoursesService } from './courses.service';
import { MaterialDto, ModuleDto } from './courses.dto';

@ApiTags('courses')
@ApiBearerAuth()
@Controller()
export class CoursesController {
  constructor(private courses: CoursesService) {}

  @Get('courses')
  list(
    @CurrentUser() user: SafeUser,
    @Query() query: Record<string, string>,
  ) {
    return this.courses.list(user, query);
  }

  @Get('courses/enrollments/me')
  enrollments(@CurrentUser() user: SafeUser) {
    return this.courses.enrollments(user);
  }

  @Get('courses/:id')
  get(@Param('id') id: string, @Query('session') session?: string) {
    return this.courses.get(id, session);
  }

  @Get('offerings/:id')
  offering(@Param('id') id: string, @CurrentUser() user: SafeUser) {
    return this.courses.offering(id, user);
  }

  @Roles('lecturer', 'hod', 'admin')
  @Post('offerings/:id/modules')
  createModule(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
    @Body() dto: ModuleDto,
  ) {
    return this.courses.createModule(id, user, dto);
  }

  @Roles('lecturer', 'hod', 'admin')
  @Delete('modules/:id')
  removeModule(@Param('id') id: string, @CurrentUser() user: SafeUser) {
    return this.courses.removeModule(id, user);
  }

  @Roles('lecturer', 'hod', 'admin')
  @Post('modules/:id/materials')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 50 * 1024 * 1024 },
      storage: undefined,
    }),
  )
  createMaterial(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
    @Body() dto: MaterialDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.courses.createMaterial(id, user, dto, file);
  }

  @Roles('lecturer', 'hod', 'admin')
  @Put('materials/:id')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 50 * 1024 * 1024 },
      storage: undefined,
    }),
  )
  updateMaterial(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
    @Body() dto: MaterialDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.courses.updateMaterial(id, user, dto, file);
  }

  @Roles('lecturer', 'hod', 'admin')
  @Patch('materials/:id/status')
  toggleMaterial(@Param('id') id: string, @CurrentUser() user: SafeUser) {
    return this.courses.toggleMaterial(id, user);
  }

  @Roles('lecturer', 'hod', 'admin')
  @Delete('materials/:id')
  removeMaterial(@Param('id') id: string, @CurrentUser() user: SafeUser) {
    return this.courses.removeMaterial(id, user);
  }

  @Get('materials/:id/download')
  async downloadMaterial(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
    @Res() res: Response,
  ) {
    const file = await this.courses.getMaterialFile(id, user);
    const safeFilename = encodeURIComponent(file.fileName).replace(
      /['()]/g,
      escape,
    );
    res.setHeader('Content-Type', file.mimeType || 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeFilename}"`,
    );
    res.setHeader('Content-Length', file.sizeBytes);
    res.send(file.buffer);
  }
}
