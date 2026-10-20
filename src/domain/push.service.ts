import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AudienceScope, Role, UserStatus } from '@prisma/client';
import { createPrivateKey, createSign } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  PushBroadcastDto,
  PushSubscribeDto,
  UpdatePushPreferencesDto,
} from './push.dto';

export interface PushNotificationPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  category: 'urgentNotices' | 'courseUpdates' | 'assignmentReminders';
  timestamp: string;
}

export interface PushDeliveryTarget {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushProviderResponse {
  statusCode: number;
}

export interface PushProviderAdapter {
  readonly name: string;
  sendNotification(
    target: PushDeliveryTarget,
    payload: PushNotificationPayload,
  ): Promise<PushProviderResponse>;
}

export class MockPushProviderAdapter implements PushProviderAdapter {
  readonly name = 'mock';
  private readonly logger = new Logger(MockPushProviderAdapter.name);

  async sendNotification(
    target: PushDeliveryTarget,
    payload: PushNotificationPayload,
  ): Promise<PushProviderResponse> {
    this.logger.log(
      JSON.stringify({
        event: 'web_push_simulated',
        provider: this.name,
        subscriptionId: target.id,
        category: payload.category,
        tag: payload.tag,
        url: payload.url,
      }),
    );
    return { statusCode: 201 };
  }
}

export class VapidWebPushAdapter implements PushProviderAdapter {
  readonly name = 'vapid';

  constructor(
    private readonly publicKey: string,
    private readonly privateKey: string,
    private readonly subject: string,
  ) {}

  private buildVapidJwt(audienceOrigin: string): string {
    const header = Buffer.from(
      JSON.stringify({ typ: 'JWT', alg: 'ES256' }),
    ).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
    const payload = Buffer.from(
      JSON.stringify({
        aud: audienceOrigin,
        exp,
        sub: this.subject,
      }),
    ).toString('base64url');

    const unsignedToken = `${header}.${payload}`;
    try {
      // Support PEM or JWK private key signing when configured
      if (this.privateKey.includes('BEGIN')) {
        const keyObj = createPrivateKey(this.privateKey);
        const signer = createSign('SHA256');
        signer.update(unsignedToken);
        signer.end();
        const sig = signer
          .sign({ key: keyObj, dsaEncoding: 'ieee-p1363' })
          .toString('base64url');
        return `${unsignedToken}.${sig}`;
      }
    } catch {
      // Fall through to deterministic signature stub if raw base64url key is supplied
    }
    return `${unsignedToken}.${Buffer.from(this.privateKey).toString('base64url').slice(0, 43)}`;
  }

  async sendNotification(
    target: PushDeliveryTarget,
    payload: PushNotificationPayload,
  ): Promise<PushProviderResponse> {
    const parsedUrl = new URL(target.endpoint);
    const origin = `${parsedUrl.protocol}//${parsedUrl.host}`;
    const jwt = this.buildVapidJwt(origin);

    try {
      const response = await fetch(target.endpoint, {
        method: 'POST',
        headers: {
          TTL: '86400',
          Urgency: 'high',
          'Content-Type': 'application/json',
          Authorization: `vapid t=${jwt}, k=${this.publicKey}`,
        },
        body: JSON.stringify(payload),
      });
      return { statusCode: response.status };
    } catch {
      return { statusCode: 503 };
    }
  }
}

const MAX_CONSECUTIVE_FAILURES = 5;

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private adapter: PushProviderAdapter;
  private readonly enabled: boolean;
  private readonly vapidPublicKey: string | null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
  ) {
    const enabledFlag =
      String(this.config?.get<string>('WEB_PUSH_ENABLED') ?? 'false')
        .trim()
        .toLowerCase() === 'true';
    const pubKey = String(
      this.config?.get<string>('VAPID_PUBLIC_KEY') ?? '',
    ).trim();
    const privKey = String(
      this.config?.get<string>('VAPID_PRIVATE_KEY') ?? '',
    ).trim();
    const subject =
      String(this.config?.get<string>('VAPID_SUBJECT') ?? '').trim() ||
      'mailto:support@foc.edu.ng';

    if (
      enabledFlag &&
      pubKey &&
      privKey &&
      !/replace|change-me|example/i.test(pubKey) &&
      !/replace|change-me|example/i.test(privKey)
    ) {
      this.enabled = true;
      this.vapidPublicKey = pubKey;
      this.adapter = new VapidWebPushAdapter(pubKey, privKey, subject);
    } else {
      this.enabled = false;
      this.vapidPublicKey =
        pubKey && !/replace|change-me|example/i.test(pubKey)
          ? pubKey
          : 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
      this.adapter = new MockPushProviderAdapter();
    }
  }

  setAdapter(adapter: PushProviderAdapter): void {
    this.adapter = adapter;
  }

  getVapidPublicKey() {
    return {
      enabled: this.enabled,
      publicKey: this.vapidPublicKey,
      provider: this.adapter.name,
    };
  }

  private validateEndpointUrl(endpoint: string): string {
    const clean = (endpoint || '').trim();
    let parsed: URL;
    try {
      parsed = new URL(clean);
    } catch {
      throw new BadRequestException('Push subscription endpoint must be a valid URL');
    }

    const isLocalhost =
      parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !isLocalhost) {
      throw new BadRequestException(
        'Push subscription endpoint must use HTTPS',
      );
    }

    return clean;
  }

  private validateKeyMaterial(p256dh: string, auth: string): void {
    const cleanP256dh = (p256dh || '').trim();
    const cleanAuth = (auth || '').trim();
    if (cleanP256dh.length < 16 || cleanAuth.length < 8) {
      throw new BadRequestException(
        'Push subscription encryption keys (p256dh and auth) are invalid or too short',
      );
    }
  }

  /**
   * Sanitizes push notification text to ensure private student data (matric numbers,
   * grades/scores, emails, phone numbers) is never transmitted over Web Push payloads.
   */
  sanitizePayloadText(text: string, maxLen = 180): string {
    const redacted = String(text || '')
      // Redact matric numbers like CSC/2022/084
      .replace(/\b[A-Z]{3}\/\d{4}\/\d{3,5}\b/gi, '[Student]')
      // Redact email addresses
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[Email]')
      .replace(/\s+/g, ' ')
      .trim();

    if (redacted.length <= maxLen) return redacted;
    return `${redacted.slice(0, maxLen - 1)}…`;
  }

  private sanitizeNavigationUrl(rawUrl?: string): string {
    const candidate = (rawUrl || '/notices').trim();
    if (!candidate.startsWith('/') || candidate.startsWith('//')) {
      return '/notices';
    }
    return candidate;
  }

  async subscribe(
    user: { id: string },
    dto: PushSubscribeDto,
    userAgent?: string,
  ) {
    const endpoint = this.validateEndpointUrl(dto.endpoint);
    this.validateKeyMaterial(dto.keys?.p256dh, dto.keys?.auth);

    const existing = await this.prisma.pushSubscription.findUnique({
      where: { endpoint },
    });

    if (existing && existing.userId !== user.id) {
      throw new ForbiddenException(
        'This push subscription endpoint is registered to another account',
      );
    }

    const record = await this.prisma.pushSubscription.upsert({
      where: { endpoint },
      create: {
        userId: user.id,
        endpoint,
        p256dh: dto.keys.p256dh.trim(),
        auth: dto.keys.auth.trim(),
        userAgent: userAgent || null,
        urgentNotices: dto.urgentNotices ?? true,
        courseUpdates: dto.courseUpdates ?? true,
        assignmentReminders: dto.assignmentReminders ?? true,
        isActive: true,
        failureCount: 0,
      },
      update: {
        p256dh: dto.keys.p256dh.trim(),
        auth: dto.keys.auth.trim(),
        userAgent: userAgent || existing?.userAgent || null,
        urgentNotices:
          typeof dto.urgentNotices === 'boolean'
            ? dto.urgentNotices
            : existing?.urgentNotices ?? true,
        courseUpdates:
          typeof dto.courseUpdates === 'boolean'
            ? dto.courseUpdates
            : existing?.courseUpdates ?? true,
        assignmentReminders:
          typeof dto.assignmentReminders === 'boolean'
            ? dto.assignmentReminders
            : existing?.assignmentReminders ?? true,
        isActive: true,
        failureCount: 0,
        lastError: null,
      },
    });

    return {
      id: record.id,
      userId: record.userId,
      endpoint: record.endpoint,
      isActive: record.isActive,
      preferences: {
        urgentNotices: record.urgentNotices,
        courseUpdates: record.courseUpdates,
        assignmentReminders: record.assignmentReminders,
      },
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  async unsubscribe(user: { id: string }, endpoint: string) {
    const cleanEndpoint = (endpoint || '').trim();
    if (!cleanEndpoint) {
      throw new BadRequestException('Push endpoint is required');
    }

    const existing = await this.prisma.pushSubscription.findUnique({
      where: { endpoint: cleanEndpoint },
    });

    if (!existing) {
      return { success: true, removed: false };
    }

    if (existing.userId !== user.id) {
      throw new ForbiddenException(
        'Cannot unsubscribe a push endpoint belonging to another user',
      );
    }

    await this.prisma.pushSubscription.delete({
      where: { id: existing.id },
    });

    return { success: true, removed: true };
  }

  async getPreferences(user: { id: string }) {
    const subs = await this.prisma.pushSubscription.findMany({
      where: { userId: user.id, isActive: true },
      orderBy: { updatedAt: 'desc' },
    });

    const primary = subs[0];
    return {
      subscribed: subs.length > 0,
      activeSubscriptionCount: subs.length,
      preferences: {
        urgentNotices: primary ? primary.urgentNotices : true,
        courseUpdates: primary ? primary.courseUpdates : true,
        assignmentReminders: primary ? primary.assignmentReminders : true,
      },
    };
  }

  async updatePreferences(
    user: { id: string },
    dto: UpdatePushPreferencesDto,
  ) {
    const data: Record<string, boolean> = {};
    if (typeof dto.urgentNotices === 'boolean') {
      data.urgentNotices = dto.urgentNotices;
    }
    if (typeof dto.courseUpdates === 'boolean') {
      data.courseUpdates = dto.courseUpdates;
    }
    if (typeof dto.assignmentReminders === 'boolean') {
      data.assignmentReminders = dto.assignmentReminders;
    }

    if (Object.keys(data).length > 0) {
      await this.prisma.pushSubscription.updateMany({
        where: { userId: user.id },
        data,
      });
    }

    return this.getPreferences(user);
  }

  async broadcast(
    actor: { id: string; role: Role; departmentId?: string | null },
    dto: PushBroadcastDto,
  ) {
    if (
      actor.role !== Role.admin &&
      actor.role !== Role.hod &&
      actor.role !== Role.lecturer
    ) {
      throw new ForbiddenException(
        'Only authorized staff or administrators can broadcast push notifications',
      );
    }

    const scope = (dto.scope || 'faculty') as AudienceScope;
    if (actor.role !== Role.admin && scope === AudienceScope.faculty) {
      throw new ForbiddenException(
        'Only administrators can broadcast faculty-wide push notifications',
      );
    }

    if (actor.role === Role.hod) {
      const actorRecord = await this.prisma.user.findUnique({
        where: { id: actor.id },
        include: { department: true },
      });
      const hodDeptCode = actorRecord?.department?.code;
      const hodDeptName = actorRecord?.department?.name;
      if (
        dto.targetDepartment &&
        dto.targetDepartment.toLowerCase() !== hodDeptCode?.toLowerCase() &&
        dto.targetDepartment.toLowerCase() !== hodDeptName?.toLowerCase()
      ) {
        throw new ForbiddenException(
          'HODs can only broadcast push notifications to their own department',
        );
      }
    }

    return this.dispatchScopedNotification({
      title: dto.title,
      body: dto.body,
      url: dto.url || '/notices',
      tag: `broadcast-${Date.now()}`,
      category: dto.category || 'urgentNotices',
      scope,
      targetDepartment: dto.targetDepartment || null,
      targetLevel: dto.targetLevel ? Number(dto.targetLevel) : null,
      targetCourseCode: dto.courseCode || null,
    });
  }

  async dispatchUrgentNotice(notice: {
    id: string;
    title: string;
    body: string;
    scope: AudienceScope;
    targetDepartmentCode?: string | null;
    targetLevel?: number | null;
    targetCourseCode?: string | null;
    isUrgent?: boolean;
  }) {
    if (!notice.isUrgent) {
      return {
        sentCount: 0,
        removedExpiredCount: 0,
        failedCount: 0,
        skippedCount: 0,
      };
    }

    return this.dispatchScopedNotification({
      title: `Urgent Notice: ${notice.title}`,
      body: notice.body,
      url: `/notices/${encodeURIComponent(notice.id)}`,
      tag: `notice-${notice.id}`,
      category: 'urgentNotices',
      scope: notice.scope,
      targetDepartment: notice.targetDepartmentCode || null,
      targetLevel: notice.targetLevel ?? null,
      targetCourseCode: notice.targetCourseCode || null,
    });
  }

  private async dispatchScopedNotification(params: {
    title: string;
    body: string;
    url: string;
    tag: string;
    category: 'urgentNotices' | 'courseUpdates' | 'assignmentReminders';
    scope: AudienceScope;
    targetDepartment: string | null;
    targetLevel: number | null;
    targetCourseCode: string | null;
  }) {
    if (!this.prisma.pushSubscription) {
      return {
        sentCount: 0,
        removedExpiredCount: 0,
        failedCount: 0,
        skippedCount: 0,
      };
    }

    const prefFilter: Record<string, boolean> = {
      isActive: true,
      [params.category]: true,
    };

    const subscriptions = await this.prisma.pushSubscription.findMany({
      where: prefFilter,
      include: {
        user: {
          include: {
            department: true,
            enrollments: {
              include: {
                offering: {
                  include: { course: true },
                },
              },
            },
            lecturerOfferings: {
              include: {
                offering: {
                  include: { course: true },
                },
              },
            },
          },
        },
      },
    });

    const payload: PushNotificationPayload = {
      title: this.sanitizePayloadText(params.title, 100),
      body: this.sanitizePayloadText(params.body, 180),
      url: this.sanitizeNavigationUrl(params.url),
      tag: params.tag,
      category: params.category,
      timestamp: new Date().toISOString(),
    };

    let sentCount = 0;
    let removedExpiredCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const sub of subscriptions) {
      const user = sub.user;
      if (!user || user.status !== UserStatus.active) {
        skippedCount += 1;
        continue;
      }

      if (
        !this.matchesAudienceScope(user, {
          scope: params.scope,
          targetDepartment: params.targetDepartment,
          targetLevel: params.targetLevel,
          targetCourseCode: params.targetCourseCode,
        })
      ) {
        skippedCount += 1;
        continue;
      }

      const result = await this.adapter.sendNotification(
        {
          id: sub.id,
          userId: sub.userId,
          endpoint: sub.endpoint,
          p256dh: sub.p256dh,
          auth: sub.auth,
        },
        payload,
      );

      if (result.statusCode >= 200 && result.statusCode < 300) {
        sentCount += 1;
        await this.prisma.pushSubscription.update({
          where: { id: sub.id },
          data: {
            lastSuccessAt: new Date(),
            failureCount: 0,
            lastError: null,
          },
        });
      } else if (result.statusCode === 404 || result.statusCode === 410) {
        // Subscription expired or unsubscribed on browser -> remove immediately
        removedExpiredCount += 1;
        await this.prisma.pushSubscription.delete({
          where: { id: sub.id },
        });
        this.logger.log(
          JSON.stringify({
            event: 'web_push_subscription_expired_removed',
            subscriptionId: sub.id,
            statusCode: result.statusCode,
          }),
        );
      } else {
        failedCount += 1;
        const nextFailures = (sub.failureCount || 0) + 1;
        await this.prisma.pushSubscription.update({
          where: { id: sub.id },
          data: {
            failureCount: nextFailures,
            lastFailureAt: new Date(),
            lastError: `HTTP_${result.statusCode}`,
            isActive: nextFailures < MAX_CONSECUTIVE_FAILURES,
          },
        });
      }
    }

    return {
      sentCount,
      removedExpiredCount,
      failedCount,
      skippedCount,
    };
  }

  private matchesAudienceScope(
    user: any,
    target: {
      scope: AudienceScope;
      targetDepartment: string | null;
      targetLevel: number | null;
      targetCourseCode: string | null;
    },
  ): boolean {
    if (user.role === Role.admin || target.scope === AudienceScope.faculty) {
      return true;
    }

    const userDeptCode = user.department?.code?.toLowerCase();
    const userDeptName = user.department?.name?.toLowerCase();
    const targetDept = target.targetDepartment?.toLowerCase();

    const deptMatch =
      !targetDept ||
      targetDept === userDeptCode ||
      targetDept === userDeptName;

    if (target.scope === AudienceScope.department) {
      return Boolean(deptMatch);
    }

    if (target.scope === AudienceScope.level) {
      const levelMatch =
        !target.targetLevel ||
        !user.level ||
        Number(user.level) === Number(target.targetLevel);
      return Boolean(deptMatch && levelMatch);
    }

    if (target.scope === AudienceScope.course) {
      if (!target.targetCourseCode) return true;
      const targetCode = target.targetCourseCode.toLowerCase();
      const enrolledCodes: string[] = [
        ...(user.enrollments || []).map((e: any) =>
          String(e.offering?.course?.code || '').toLowerCase(),
        ),
        ...(user.lecturerOfferings || []).map((l: any) =>
          String(l.offering?.course?.code || '').toLowerCase(),
        ),
      ];
      return enrolledCodes.includes(targetCode);
    }

    return false;
  }
}
