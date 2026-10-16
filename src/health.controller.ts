import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/auth.decorators';
import { PrismaService } from './prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

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

  @Public()
  @Get('db')
  async checkDb() {
    await this.prisma.$queryRawUnsafe('SELECT 1 as result;');
    return { status: 'ok', database: 'connected' };
  }
}
