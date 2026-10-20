import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';

export type EmailTemplateType =
  | 'activation_code'
  | 'password_reset'
  | 'account_approved';

export interface TransactionalEmailPayload {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  template: EmailTemplateType;
  idempotencyKey: string;
}

export interface EmailProviderResponse {
  providerMessageId: string;
  status: 'sent' | 'simulated';
}

export interface EmailDeliveryReceipt {
  status: 'sent' | 'simulated' | 'deduplicated' | 'rate_limited' | 'failed';
  provider: string;
  template: EmailTemplateType;
  maskedRecipient: string;
  messageId?: string;
  attempts: number;
  errorCode?: string;
}

export interface EmailProviderAdapter {
  readonly name: string;
  send(payload: TransactionalEmailPayload): Promise<EmailProviderResponse>;
}

export class ProviderDeliveryError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderDeliveryError';
  }
}

export function maskEmailAddress(email: string): string {
  const clean = (email || '').trim().toLowerCase();
  const atIdx = clean.indexOf('@');
  if (atIdx <= 0) return '***@invalid';
  const local = clean.slice(0, atIdx);
  const domain = clean.slice(atIdx + 1);
  const prefix = local.slice(0, 1);
  return `${prefix}***@${domain}`;
}

function escapeHtml(input: string): string {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class ConsoleEmailAdapter implements EmailProviderAdapter {
  readonly name = 'console';
  private readonly logger = new Logger(ConsoleEmailAdapter.name);

  async send(
    payload: TransactionalEmailPayload,
  ): Promise<EmailProviderResponse> {
    const providerMessageId = `sim-${randomUUID()}`;
    // SECURITY: Never log activation codes, reset tokens, or raw email bodies
    this.logger.log(
      JSON.stringify({
        event: 'transactional_email_simulated',
        provider: this.name,
        template: payload.template,
        to: maskEmailAddress(payload.to),
        idempotencyKey: payload.idempotencyKey,
        messageId: providerMessageId,
      }),
    );
    return {
      providerMessageId,
      status: 'simulated',
    };
  }
}

export class ManagedHttpEmailAdapter implements EmailProviderAdapter {
  readonly name: string;

  constructor(
    providerName: string,
    private readonly apiKey: string,
    private readonly endpoint: string,
  ) {
    this.name = providerName;
  }

  async send(
    payload: TransactionalEmailPayload,
  ): Promise<EmailProviderResponse> {
    let response: Response;
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Idempotency-Key': payload.idempotencyKey,
      };

      if (this.name === 'postmark') {
        headers['X-Postmark-Server-Token'] = this.apiKey;
      } else {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const body =
        this.name === 'postmark'
          ? {
              From: payload.from,
              To: payload.to,
              ReplyTo: payload.replyTo,
              Subject: payload.subject,
              HtmlBody: payload.html,
              TextBody: payload.text,
              MessageStream: 'outbound',
            }
          : {
              from: payload.from,
              to: [payload.to],
              reply_to: payload.replyTo,
              subject: payload.subject,
              html: payload.html,
              text: payload.text,
            };

      response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      throw new ProviderDeliveryError(
        err?.message || 'Network transport failure contacting email provider',
        503,
        true,
      );
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new ProviderDeliveryError(
        `Email provider HTTP ${response.status}`,
        response.status,
        retryable,
      );
    }

    let data: any = {};
    try {
      data = await response.json();
    } catch {
      // Ignore non-JSON body on 2xx
    }

    return {
      providerMessageId: String(
        data?.id || data?.MessageID || `msg-${randomUUID()}`,
      ),
      status: 'sent',
    };
  }
}

export interface IMailService {
  sendActivationCode(
    email: string,
    code: string,
    options?: {
      fullName?: string;
      matricNo?: string;
      idempotencyKey?: string;
    },
  ): Promise<EmailDeliveryReceipt>;
  sendPasswordReset(
    email: string,
    token: string,
    options?: { fullName?: string; idempotencyKey?: string },
  ): Promise<EmailDeliveryReceipt>;
  sendAccountApprovedNotification(
    email: string,
    options?: {
      fullName?: string;
      role?: string;
      department?: string;
      idempotencyKey?: string;
    },
  ): Promise<EmailDeliveryReceipt>;
}

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_EMAILS_PER_WINDOW = 5;
const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000; // 15 minutes

@Injectable()
export class MailService implements IMailService {
  private readonly logger = new Logger(MailService.name);
  private adapter: EmailProviderAdapter;
  private readonly fromHeader: string;
  private readonly replyTo?: string;
  private readonly frontendUrl: string;
  private readonly maxRetries: number;

  private readonly rateWindowMap = new Map<string, number[]>();
  private readonly idempotencyCache = new Map<
    string,
    { expiresAt: number; receipt: EmailDeliveryReceipt }
  >();

  constructor(@Optional() private readonly config?: ConfigService) {
    const provider = String(
      this.config?.get<string>('EMAIL_PROVIDER') ?? 'console',
    )
      .trim()
      .toLowerCase();
    const fromAddress =
      this.config?.get<string>('EMAIL_FROM_ADDRESS') || 'no-reply@foc.edu.ng';
    const fromName =
      this.config?.get<string>('EMAIL_FROM_NAME') ||
      'CODICS — Faculty of Computing';
    this.fromHeader = `${fromName} <${fromAddress}>`;
    this.replyTo =
      this.config?.get<string>('EMAIL_REPLY_TO') || 'support@foc.edu.ng';
    this.frontendUrl = (
      this.config?.get<string>('FRONTEND_URL') || 'http://localhost:5173'
    ).replace(/\/+$/, '');
    this.maxRetries = Number(this.config?.get<number>('EMAIL_MAX_RETRIES') ?? 2);

    const apiKey = String(this.config?.get<string>('EMAIL_API_KEY') ?? '').trim();
    const defaultEndpoint =
      provider === 'postmark'
        ? 'https://api.postmarkapp.com/email'
        : provider === 'sendgrid'
          ? 'https://api.sendgrid.com/v3/mail/send'
          : 'https://api.resend.com/emails';
    const endpoint =
      this.config?.get<string>('EMAIL_API_ENDPOINT') || defaultEndpoint;

    if (
      ['resend', 'postmark', 'sendgrid', 'http'].includes(provider) &&
      apiKey &&
      !/replace|change-me|example/i.test(apiKey)
    ) {
      this.adapter = new ManagedHttpEmailAdapter(provider, apiKey, endpoint);
    } else {
      this.adapter = new ConsoleEmailAdapter();
    }
  }

  setAdapter(adapter: EmailProviderAdapter): void {
    this.adapter = adapter;
  }

  clearCachesForTesting(): void {
    this.rateWindowMap.clear();
    this.idempotencyCache.clear();
  }

  private buildDeterministicIdempotencyKey(
    template: EmailTemplateType,
    recipient: string,
    secretOrNonce: string,
  ): string {
    return createHash('sha256')
      .update(`${template}:${recipient.trim().toLowerCase()}:${secretOrNonce}`)
      .digest('hex')
      .slice(0, 32);
  }

  private checkRateLimit(recipient: string, template: EmailTemplateType): boolean {
    const key = `${recipient.trim().toLowerCase()}:${template}`;
    const now = Date.now();
    const existing = (this.rateWindowMap.get(key) || []).filter(
      (ts) => now - ts < RATE_LIMIT_WINDOW_MS,
    );
    if (existing.length >= MAX_EMAILS_PER_WINDOW) {
      this.rateWindowMap.set(key, existing);
      return false;
    }
    existing.push(now);
    this.rateWindowMap.set(key, existing);
    return true;
  }

  private renderBrandedLayout(params: {
    preheader: string;
    heading: string;
    greeting: string;
    bodyHtml: string;
    calloutLabel?: string;
    calloutValue?: string;
    ctaLabel?: string;
    ctaUrl?: string;
    footerNote: string;
  }): string {
    const calloutBlock =
      params.calloutLabel && params.calloutValue
        ? `
          <div style="margin:24px 0;padding:18px 20px;background-color:#F0FDF4;border:1px solid #BBF7D0;border-radius:12px;text-align:center;">
            <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#166534;margin-bottom:6px;">
              ${escapeHtml(params.calloutLabel)}
            </div>
            <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:28px;font-weight:800;letter-spacing:0.18em;color:#14532D;">
              ${escapeHtml(params.calloutValue)}
            </div>
          </div>`
        : '';

    const ctaBlock =
      params.ctaLabel && params.ctaUrl
        ? `
          <div style="margin:24px 0;text-align:center;">
            <a href="${escapeHtml(params.ctaUrl)}" style="display:inline-block;padding:12px 24px;background-color:#15803D;color:#FFFFFF;font-weight:700;font-size:14px;text-decoration:none;border-radius:10px;">
              ${escapeHtml(params.ctaLabel)}
            </a>
          </div>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <title>${escapeHtml(params.heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:#F8FAFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0F172A;">
  <span style="display:none;visibility:hidden;opacity:0;height:0;width:0;font-size:1px;">
    ${escapeHtml(params.preheader)}
  </span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F8FAFC;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#FFFFFF;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden;">
          <tr>
            <td style="background-color:#15803D;padding:20px 24px;color:#FFFFFF;">
              <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;opacity:0.9;">
                Faculty of Computing Digital Information &amp; Course System
              </div>
              <div style="font-size:20px;font-weight:800;margin-top:4px;">
                CODICS Portal
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 24px;">
              <h1 style="margin:0 0 12px 0;font-size:18px;font-weight:800;color:#0F172A;">
                ${escapeHtml(params.heading)}
              </h1>
              <p style="margin:0 0 14px 0;font-size:14px;line-height:1.6;color:#334155;">
                ${escapeHtml(params.greeting)}
              </p>
              <div style="font-size:14px;line-height:1.6;color:#334155;">
                ${params.bodyHtml}
              </div>
              ${calloutBlock}
              ${ctaBlock}
              <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0;" />
              <p style="margin:0;font-size:12px;line-height:1.5;color:#64748B;">
                ${escapeHtml(params.footerNote)}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  private async dispatchWithRetry(
    payload: TransactionalEmailPayload,
  ): Promise<EmailDeliveryReceipt> {
    const maskedRecipient = maskEmailAddress(payload.to);
    const now = Date.now();

    // 1. Check idempotency cache first so duplicate retries never re-send
    const cached = this.idempotencyCache.get(payload.idempotencyKey);
    if (cached && cached.expiresAt > now) {
      return {
        ...cached.receipt,
        status: 'deduplicated',
      };
    }

    // 2. Enforce per-recipient + per-template rate limit
    if (!this.checkRateLimit(payload.to, payload.template)) {
      this.logger.warn(
        JSON.stringify({
          event: 'transactional_email_rate_limited',
          provider: this.adapter.name,
          template: payload.template,
          to: maskedRecipient,
        }),
      );
      return {
        status: 'rate_limited',
        provider: this.adapter.name,
        template: payload.template,
        maskedRecipient,
        attempts: 0,
        errorCode: 'RATE_LIMIT_EXCEEDED',
      };
    }

    let attempts = 0;
    let lastError: any = null;

    while (attempts <= this.maxRetries) {
      attempts += 1;
      try {
        const res = await this.adapter.send(payload);
        const receipt: EmailDeliveryReceipt = {
          status: res.status,
          provider: this.adapter.name,
          template: payload.template,
          maskedRecipient,
          messageId: res.providerMessageId,
          attempts,
        };
        this.idempotencyCache.set(payload.idempotencyKey, {
          expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
          receipt,
        });
        this.logger.log(
          JSON.stringify({
            event: 'transactional_email_delivered',
            provider: this.adapter.name,
            template: payload.template,
            to: maskedRecipient,
            status: res.status,
            attempts,
            messageId: res.providerMessageId,
          }),
        );
        return receipt;
      } catch (err: any) {
        lastError = err;
        const retryable =
          err instanceof ProviderDeliveryError ? err.retryable : true;
        if (!retryable || attempts > this.maxRetries) {
          break;
        }
      }
    }

    const errorCode =
      lastError instanceof ProviderDeliveryError
        ? `HTTP_${lastError.statusCode}`
        : 'DELIVERY_ERROR';

    this.logger.error(
      JSON.stringify({
        event: 'transactional_email_failed',
        provider: this.adapter.name,
        template: payload.template,
        to: maskedRecipient,
        attempts,
        errorCode,
      }),
    );

    return {
      status: 'failed',
      provider: this.adapter.name,
      template: payload.template,
      maskedRecipient,
      attempts,
      errorCode,
    };
  }

  async sendActivationCode(
    email: string,
    code: string,
    options?: {
      fullName?: string;
      matricNo?: string;
      idempotencyKey?: string;
    },
  ): Promise<EmailDeliveryReceipt> {
    const cleanCode = String(code || '')
      .trim()
      .split(/\s+/)[0];
    const idempotencyKey =
      options?.idempotencyKey ||
      this.buildDeterministicIdempotencyKey('activation_code', email, cleanCode);

    const greeting = options?.fullName
      ? `Hello ${options.fullName},`
      : 'Hello Student,';

    const html = this.renderBrandedLayout({
      preheader: 'Your CODICS account activation verification code (valid for 10 minutes).',
      heading: 'Verify Your CODICS Student Account',
      greeting,
      bodyHtml: `<p style="margin:0;">Use the 6-digit single-use verification code below to complete your CODICS portal activation${
        options?.matricNo ? ` for matric number <strong>${escapeHtml(options.matricNo)}</strong>` : ''
      }. This code expires in <strong>10 minutes</strong>.</p>`,
      calloutLabel: 'Single-Use Activation Code',
      calloutValue: cleanCode,
      ctaLabel: 'Open Activation Portal',
      ctaUrl: `${this.frontendUrl}/activate`,
      footerNote:
        'If you did not request this code, you can safely ignore this email. Never share your activation code with anyone.',
    });

    const text = [
      'CODICS — Faculty of Computing Portal',
      'Verify Your Student Account',
      '',
      greeting,
      `Your single-use 6-digit activation code is: ${cleanCode}`,
      'This code expires in 10 minutes.',
      `Complete activation at: ${this.frontendUrl}/activate`,
      '',
      'If you did not request this code, please ignore this email.',
    ].join('\n');

    return this.dispatchWithRetry({
      to: email,
      from: this.fromHeader,
      replyTo: this.replyTo,
      subject: 'Your CODICS Account Activation Code',
      html,
      text,
      template: 'activation_code',
      idempotencyKey,
    });
  }

  async sendPasswordReset(
    email: string,
    token: string,
    options?: { fullName?: string; idempotencyKey?: string },
  ): Promise<EmailDeliveryReceipt> {
    const cleanToken = String(token || '').trim();
    const idempotencyKey =
      options?.idempotencyKey ||
      this.buildDeterministicIdempotencyKey(
        'password_reset',
        email,
        cleanToken,
      );

    const resetUrl = `${this.frontendUrl}/forgot-password?token=${encodeURIComponent(cleanToken)}`;
    const greeting = options?.fullName ? `Hello ${options.fullName},` : 'Hello,';

    const html = this.renderBrandedLayout({
      preheader: 'Password reset instructions for your CODICS account (expires in 30 minutes).',
      heading: 'Reset Your CODICS Password',
      greeting,
      bodyHtml: `<p style="margin:0;">We received a request to reset the password for your Faculty of Computing CODICS account. Select the button below to choose a new password. This single-use reset link expires in <strong>30 minutes</strong>.</p>`,
      ctaLabel: 'Reset Password',
      ctaUrl: resetUrl,
      footerNote:
        'If you did not request a password reset, no changes have been made to your account and you may safely ignore this message.',
    });

    const text = [
      'CODICS — Faculty of Computing Portal',
      'Reset Your Password',
      '',
      greeting,
      'We received a request to reset your CODICS password.',
      `Reset link (valid for 30 minutes, single-use): ${resetUrl}`,
      '',
      'If you did not request a password reset, you can safely ignore this message.',
    ].join('\n');

    return this.dispatchWithRetry({
      to: email,
      from: this.fromHeader,
      replyTo: this.replyTo,
      subject: 'Reset Your CODICS Portal Password',
      html,
      text,
      template: 'password_reset',
      idempotencyKey,
    });
  }

  async sendAccountApprovedNotification(
    email: string,
    options?: {
      fullName?: string;
      role?: string;
      department?: string;
      idempotencyKey?: string;
    },
  ): Promise<EmailDeliveryReceipt> {
    const idempotencyKey =
      options?.idempotencyKey ||
      this.buildDeterministicIdempotencyKey(
        'account_approved',
        email,
        `${options?.role || 'student'}:${options?.department || 'computing'}`,
      );

    const greeting = options?.fullName
      ? `Hello ${options.fullName},`
      : 'Hello,';

    const html = this.renderBrandedLayout({
      preheader: 'Your Faculty of Computing CODICS account is now active.',
      heading: 'Your CODICS Account Is Active',
      greeting,
      bodyHtml: `<p style="margin:0;">Your Faculty of Computing portal account${
        options?.department ? ` (${escapeHtml(options.department)})` : ''
      } has been activated. You can now sign in to access course materials, timetables, assignments, and official notices.</p>`,
      ctaLabel: 'Sign In to CODICS',
      ctaUrl: `${this.frontendUrl}/login`,
      footerNote:
        'This is an automated security notification from the Faculty of Computing.',
    });

    const text = [
      'CODICS — Faculty of Computing Portal',
      'Your CODICS Account Is Active',
      '',
      greeting,
      'Your Faculty of Computing portal account is now active.',
      `Sign in at: ${this.frontendUrl}/login`,
    ].join('\n');

    return this.dispatchWithRetry({
      to: email,
      from: this.fromHeader,
      replyTo: this.replyTo,
      subject: 'Your CODICS Account Is Now Active',
      html,
      text,
      template: 'account_approved',
      idempotencyKey,
    });
  }
}
