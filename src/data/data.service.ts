import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { AuditEntry, Database, User } from './entities';
import { createSeed } from './seed';

@Injectable()
export class DataService implements OnModuleInit {
  private database!: Database;
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(config: ConfigService) {
    this.filePath = resolve(process.cwd(), config.get<string>('DATA_FILE', './data/codics.json'));
  }

  async onModuleInit() {
    try {
      this.database = JSON.parse(await readFile(this.filePath, 'utf8')) as Database;
    } catch {
      this.database = createSeed();
      await this.save();
    }
  }

  get db(): Database {
    return this.database;
  }

  async save(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempFile = `${this.filePath}.tmp`;
      await writeFile(tempFile, JSON.stringify(this.database, null, 2), 'utf8');
      await rename(tempFile, this.filePath);
    });
    return this.writeQueue;
  }

  async audit(actor: User, action: string, targetType: string, targetId: string, targetName: string, reason?: string) {
    const entry: AuditEntry = {
      id: randomUUID(), actorId: actor.id, actorName: actor.name, actorRole: actor.role,
      action, targetType, targetId, targetName, reason, createdAt: new Date().toISOString(),
    };
    this.database.auditLogs.unshift(entry);
    await this.save();
    return entry;
  }
}
