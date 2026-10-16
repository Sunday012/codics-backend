import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CurrentUser, Public } from './auth.decorators';
import {
  ActivateDto,
  ActivateLookupDto,
  ForgotPasswordDto,
  LoginDto,
  RefreshDto,
  ResetPasswordDto,
} from './auth.dto';
import { AuthService } from './auth.service';
import { SafeUser } from '../common/user.util';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ login: { ttl: 60000, limit: 5 } })
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.login(dto, req, res);
  }

  @Public()
  @Throttle({ refresh: { ttl: 60000, limit: 20 } })
  @Post('refresh')
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.refresh(dto.refreshToken, req, res);
  }

  @Public()
  @Throttle({ activate: { ttl: 60000, limit: 5 } })
  @Post('activate/lookup')
  activateLookup(@Body() dto: ActivateLookupDto) {
    return this.auth.activateLookup(dto.matricNo);
  }

  @Public()
  @Throttle({ activate: { ttl: 60000, limit: 5 } })
  @Post('activate/verify')
  async activateVerify(
    @Body() dto: ActivateDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.activate(dto, req, res);
  }

  // Backwards compatibility alias for existing frontend/test calls
  @Public()
  @Throttle({ activate: { ttl: 60000, limit: 5 } })
  @Post('activate')
  async activate(
    @Body() dto: ActivateDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.activate(dto, req, res);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('forgot')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('reset')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto);
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: SafeUser) {
    return user;
  }

  @ApiBearerAuth()
  @Post('logout')
  async logout(
    @CurrentUser() user: { id: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.logout(user, res);
  }
}
