import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { Role } from '@prisma/client';
import {
  PushBroadcastDto,
  PushSubscribeDto,
  PushUnsubscribeDto,
  UpdatePushPreferencesDto,
} from './push.dto';
import { PushService } from './push.service';

@ApiTags('push')
@ApiBearerAuth()
@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('vapid-public-key')
  getVapidPublicKey() {
    return this.push.getVapidPublicKey();
  }

  @Get('preferences')
  getPreferences(@CurrentUser() user: any) {
    return this.push.getPreferences(user);
  }

  @Post('subscribe')
  subscribe(
    @CurrentUser() user: any,
    @Body() dto: PushSubscribeDto,
    @Req() req: Request,
  ) {
    const userAgent = req.headers['user-agent'] || undefined;
    return this.push.subscribe(user, dto, userAgent);
  }

  @Post('unsubscribe')
  unsubscribe(@CurrentUser() user: any, @Body() dto: PushUnsubscribeDto) {
    return this.push.unsubscribe(user, dto.endpoint);
  }

  @Delete('subscribe')
  deleteSubscription(
    @CurrentUser() user: any,
    @Body() dto: PushUnsubscribeDto,
  ) {
    return this.push.unsubscribe(user, dto.endpoint);
  }

  @Patch('preferences')
  updatePreferences(
    @CurrentUser() user: any,
    @Body() dto: UpdatePushPreferencesDto,
  ) {
    return this.push.updatePreferences(user, dto);
  }

  @Post('broadcast')
  @Roles(Role.admin, Role.hod, Role.lecturer)
  broadcast(@CurrentUser() user: any, @Body() dto: PushBroadcastDto) {
    return this.push.broadcast(user, dto);
  }
}
