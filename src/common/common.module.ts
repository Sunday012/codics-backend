import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { MailService } from './mail.service';
import { StorageService } from './storage.service';

@Global()
@Module({
  providers: [AuditService, MailService, StorageService],
  exports: [AuditService, MailService, StorageService],
})
export class CommonModule {}
