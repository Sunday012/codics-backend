import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { User, toSafeUser } from '../data/entities';
import { CurrentUser, Public } from './auth.decorators';
import { ActivateDto, LoginDto, RefreshDto } from './auth.dto';
import { AuthService } from './auth.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ login: { ttl: 60000, limit: 5 } })
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Public()
  @Throttle({ refresh: { ttl: 60000, limit: 20 } })
  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @Throttle({ activate: { ttl: 60000, limit: 5 } })
  @Post('activate')
  activate(@Body() dto: ActivateDto) {
    return this.auth.activate(dto);
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: User) {
    return toSafeUser(user);
  }

  @ApiBearerAuth()
  @Post('logout')
  logout(@CurrentUser() user: User) {
    return this.auth.logout(user);
  }
}
