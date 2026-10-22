import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CurrentUser, Public, Roles } from '../auth/auth.decorators';
import { User } from '@prisma/client';
import {
  AcceptStaffInvitationDto,
  CreateStaffInvitationDto,
  ListStaffInvitationsQueryDto,
  VerifyStaffInvitationDto,
} from './staff-invitation.dto';
import { StaffInvitationService } from './staff-invitation.service';

@ApiTags('staff-invitations')
@Controller('staff-invitations')
export class StaffInvitationController {
  constructor(private readonly service: StaffInvitationService) {}

  @ApiBearerAuth()
  @Roles('admin', 'hod')
  @Throttle({ inviteCreate: { ttl: 60000, limit: 10 } })
  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateStaffInvitationDto) {
    return this.service.createInvitation(user, dto);
  }

  @ApiBearerAuth()
  @Roles('admin', 'hod')
  @Get()
  list(
    @CurrentUser() user: User,
    @Query() query: ListStaffInvitationsQueryDto,
  ) {
    return this.service.listInvitations(user, query);
  }

  @ApiBearerAuth()
  @Roles('admin', 'hod')
  @Post(':id/revoke')
  revoke(@Param('id') id: string, @CurrentUser() user: User) {
    return this.service.revokeInvitation(user, id);
  }

  @ApiBearerAuth()
  @Roles('admin', 'hod')
  @Post(':id/resend')
  resend(@Param('id') id: string, @CurrentUser() user: User) {
    return this.service.resendInvitation(user, id);
  }

  @Public()
  @Throttle({ inviteAccept: { ttl: 60000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @Post('verify')
  verify(@Body() dto: VerifyStaffInvitationDto) {
    return this.service.verifyInvitationToken(dto.token);
  }

  @Public()
  @Throttle({ inviteAccept: { ttl: 60000, limit: 5 } })
  @Get('verify')
  verifyGet(@Query('token') token: string) {
    return this.service.verifyInvitationToken(token);
  }

  @Public()
  @Throttle({ inviteAccept: { ttl: 60000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @Post('accept')
  accept(
    @Body() dto: AcceptStaffInvitationDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.service.acceptInvitation(dto, req, res);
  }
}
