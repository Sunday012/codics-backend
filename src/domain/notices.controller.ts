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
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { SafeUser } from '../common/user.util';
import { NoticeDto } from './notices.dto';
import { NoticesService } from './notices.service';

@ApiTags('notices')
@ApiBearerAuth()
@Controller('notices')
export class NoticesController {
  constructor(private readonly notices: NoticesService) {}

  @Get()
  list(@CurrentUser() user: SafeUser, @Query() query: Record<string, string>) {
    return this.notices.list(user, query);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: SafeUser) {
    return this.notices.get(id, user);
  }

  @Roles('course_rep', 'lecturer', 'hod', 'admin')
  @Post()
  create(@CurrentUser() user: SafeUser, @Body() dto: NoticeDto) {
    return this.notices.create(user, dto);
  }

  @Roles('course_rep', 'lecturer', 'hod', 'admin')
  @Put(':id')
  update(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
    @Body() dto: NoticeDto,
  ) {
    return this.notices.update(id, user, dto);
  }

  @Roles('course_rep', 'lecturer', 'hod', 'admin')
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: SafeUser) {
    return this.notices.remove(id, user);
  }

  @Patch(':id/read')
  markRead(@Param('id') id: string, @CurrentUser() user: SafeUser) {
    return this.notices.markRead(id, user);
  }

  @Roles('hod', 'admin')
  @Patch(':id/hide')
  hide(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
    @Body() body: { reason?: string },
  ) {
    return this.notices.hide(id, user, body?.reason);
  }

  @Roles('hod', 'admin')
  @Patch(':id/unhide')
  unhide(@Param('id') id: string, @CurrentUser() user: SafeUser) {
    return this.notices.unhide(id, user);
  }
}
