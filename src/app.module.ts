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
import { DataModule } from './data/data.module';
import { DomainModule } from './domain/domain.module';
import { HealthController } from './health.controller';
import { TimeController } from './time.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60000, limit: 100 },
      { name: 'login', ttl: 60000, limit: 5 },
      { name: 'activate', ttl: 60000, limit: 5 },
      { name: 'refresh', ttl: 60000, limit: 20 },
    ]),
    DataModule,
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
