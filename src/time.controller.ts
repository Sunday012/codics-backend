import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from './auth/auth.decorators';

@ApiTags('time')
@Controller('time')
export class TimeController {
  @Public()
  @Get()
  getTime() {
    return { now: new Date().toISOString() };
  }
}
