import { Injectable, Logger } from '@nestjs/common';

export interface IMailService {
  sendActivationCode(email: string, code: string): Promise<void>;
  sendPasswordReset(email: string, token: string): Promise<void>;
}

@Injectable()
export class MailService implements IMailService {
  private readonly logger = new Logger(MailService.name);

  async sendActivationCode(email: string, code: string): Promise<void> {
    // Console implementation for development and testing environments
    this.logger.log(`[MAIL] Activation code for ${email}: ${code} (expires in 10 minutes)`);
  }

  async sendPasswordReset(email: string, token: string): Promise<void> {
    // Console implementation for development and testing environments
    this.logger.log(`[MAIL] Password reset token for ${email}: ${token} (expires in 30 minutes)`);
  }
}
