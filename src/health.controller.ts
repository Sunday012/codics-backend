import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/auth.decorators';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  check() {
    return { status: 'ok', service: 'codics-api', timestamp: new Date().toISOString() };
  }

  @Public()
  @Get('time')
  getTime() {
    return { now: new Date().toISOString() };
  }
}
