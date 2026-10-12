import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { User, toSafeUser } from '../data/entities';
import { CurrentUser, Public } from './auth.decorators';
import { ActivateDto, LoginDto, RefreshDto } from './auth.dto';
import { AuthService } from './auth.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public() @Post('login') login(@Body() dto: LoginDto) { return this.auth.login(dto); }
  @Public() @Post('refresh') refresh(@Body() dto: RefreshDto) { return this.auth.refresh(dto.refreshToken); }
  @Public() @Post('activate') activate(@Body() dto: ActivateDto) { return this.auth.activate(dto); }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: User) { return toSafeUser(user); }

  @ApiBearerAuth()
  @Post('logout')
  logout(@CurrentUser() user: User) { return this.auth.logout(user); }
}
