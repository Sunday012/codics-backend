import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { validateEnvironment } from './common/config.validator';
import { CustomThrottlerGuard } from './common/custom-throttler.guard';
import { RequestLoggingMiddleware } from './common/request-logging.middleware';
import { CommonModule } from './common/common.module';
import { DomainModule } from './domain/domain.module';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { TimeController } from './time.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60000, limit: process.env.NODE_ENV === 'test' ? 1000 : 100 },
      { name: 'login', ttl: 60000, limit: 5 },
      { name: 'activate', ttl: 60000, limit: 5 },
      { name: 'refresh', ttl: 60000, limit: 20 },
      { name: 'inviteCreate', ttl: 60000, limit: process.env.NODE_ENV === 'test' ? 1000 : 10 },
      { name: 'inviteAccept', ttl: 60000, limit: process.env.NODE_ENV === 'test' ? 1000 : 5 },
    ]),
    PrismaModule,
    CommonModule,
    AuthModule,
    DomainModule,
  ],
  controllers: [HealthController, TimeController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: CustomThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestLoggingMiddleware).forRoutes('*');
  }
}
