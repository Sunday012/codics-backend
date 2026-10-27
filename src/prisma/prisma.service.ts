import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly pool: Pool;

  constructor(config: ConfigService) {
    const databaseUrl = config.getOrThrow<string>('DATABASE_URL');
    const isLocal =
      databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
    const poolMax = Number(config.get<number>('DB_POOL_MAX', 10));
    const pool = new Pool({
      connectionString: databaseUrl,
      max: poolMax,
      ssl: isLocal ? false : { rejectUnauthorized: false },
    });
    const adapter = new PrismaPg(pool);
    super({ adapter });
    this.pool = pool;
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('PrismaService connected to PostgreSQL successfully.');
    await this.ensureFoundationalData();
  }

  /**
   * Self-healing data initialization:
   * Guarantees that foundational faculty departments (CSC, SEN, CYB, IFT)
   * and initial academic setting exist in any deployment environment.
   */
  private async ensureFoundationalData() {
    try {
      const defaultDepts = [
        { id: 'dept-csc', code: 'CSC', name: 'Computer Science' },
        { id: 'dept-sen', code: 'SEN', name: 'Software Engineering' },
        { id: 'dept-cyb', code: 'CYB', name: 'Cyber Security' },
        { id: 'dept-it', code: 'IFT', name: 'Information Technology' },
      ];

      for (const d of defaultDepts) {
        await this.department.upsert({
          where: { code: d.code },
          update: { name: d.name },
          create: d,
        });
      }

      const existingSetting = await this.setting.findFirst();
      if (!existingSetting) {
        await this.setting.create({
          data: { session: '2026/2027', semester: 'first' as any },
        });
      }
      this.logger.log('Foundational departments and settings verified.');
    } catch (err: any) {
      this.logger.warn(`Could not verify foundational departments: ${err?.message}`);
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    await this.pool.end();
    this.logger.log('PrismaService disconnected and connection pool closed.');
  }
}
