import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/auth.decorators';
import { PrismaService } from './database/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private prisma: PrismaService) {}

  @Public()
  @Get()
  async check() {
    await this.prisma.$queryRawUnsafe('SELECT 1');
    return { status: 'ok', service: 'codics-api', database: 'connected', timestamp: new Date().toISOString() };
  }
}
