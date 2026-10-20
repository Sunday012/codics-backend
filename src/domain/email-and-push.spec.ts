import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { AudienceScope, Role, UserStatus } from '@prisma/client';
import {
  EmailProviderAdapter,
  MailService,
  ProviderDeliveryError,
  TransactionalEmailPayload,
} from '../common/mail.service';
import { validateEmailAndPushConfig } from '../common/config.validator';
import { PushProviderAdapter, PushService } from './push.service';

describe('Phase 7: Managed Transactional Email & Web Push Services', () => {
  describe('MailService & Email Provider Adapters', () => {
    it('renders accessible branded HTML & plain-text templates without ever logging activation codes or reset tokens', async () => {
      const mail = new MailService();
      const capturedPayloads: TransactionalEmailPayload[] = [];
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();

      const mockAdapter: EmailProviderAdapter = {
        name: 'mock-resend',
        send: jest.fn(async (payload) => {
          capturedPayloads.push(payload);
          return { providerMessageId: 'msg-101', status: 'sent' as const };
        }),
      };
      mail.setAdapter(mockAdapter);

      const secretActivationCode = '849201';
      const secretResetToken = 'tok_super_secret_reset_99887766';

      const actReceipt = await mail.sendActivationCode(
        'amina.bello@foc.edu.ng',
        secretActivationCode,
        { fullName: 'Amina Bello', matricNo: 'CSC/2026/001' },
      );

      const resetReceipt = await mail.sendPasswordReset(
        'amina.bello@foc.edu.ng',
        secretResetToken,
        { fullName: 'Amina Bello' },
      );

      const approvedReceipt = await mail.sendAccountApprovedNotification(
        'amina.bello@foc.edu.ng',
        {
          fullName: 'Amina Bello',
          role: 'student',
          department: 'Computer Science',
        },
      );

      expect(actReceipt.status).toBe('sent');
      expect(actReceipt.maskedRecipient).toBe('a***@foc.edu.ng');
      expect(resetReceipt.status).toBe('sent');
      expect(approvedReceipt.status).toBe('sent');
      expect(capturedPayloads).toHaveLength(3);

      // Verify accessible branded HTML structure
      expect(capturedPayloads[0].html).toContain('role="presentation"');
      expect(capturedPayloads[0].html).toContain('CODICS Portal');
      expect(capturedPayloads[0].html).toContain(secretActivationCode);
      expect(capturedPayloads[1].html).toContain(
        encodeURIComponent(secretResetToken),
      );

      // Verify ZERO secret leakage in logs
      const allLogs = logSpy.mock.calls.flat().join(' ');
      expect(allLogs).not.toContain(secretActivationCode);
      expect(allLogs).not.toContain(secretResetToken);
      expect(allLogs).not.toContain('amina.bello@foc.edu.ng');

      logSpy.mockRestore();
    });

    it('retries transient 5xx delivery errors idempotently, avoids duplicate sends, and enforces rate limits', async () => {
      const mail = new MailService();
      jest.spyOn(Logger.prototype, 'log').mockImplementation();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      jest.spyOn(Logger.prototype, 'error').mockImplementation();

      let callCount = 0;
      const flakyAdapter: EmailProviderAdapter = {
        name: 'flaky-provider',
        send: jest.fn(async () => {
          callCount += 1;
          if (callCount === 1) {
            throw new ProviderDeliveryError('Temporary 503', 503, true);
          }
          return { providerMessageId: 'msg-recovered', status: 'sent' as const };
        }),
      };
      mail.setAdapter(flakyAdapter);

      // First call fails once with 503 then succeeds on retry #2
      const receipt1 = await mail.sendActivationCode(
        'student1@foc.edu.ng',
        '112233',
        { idempotencyKey: 'idem-key-1' },
      );
      expect(receipt1.status).toBe('sent');
      expect(receipt1.attempts).toBe(2);

      // Duplicate retry with the same idempotencyKey is deduplicated without calling provider again
      const receiptDup = await mail.sendActivationCode(
        'student1@foc.edu.ng',
        '112233',
        { idempotencyKey: 'idem-key-1' },
      );
      expect(receiptDup.status).toBe('deduplicated');
      expect(callCount).toBe(2);

      // Non-retryable 400 error fails immediately on attempt 1 without retrying
      const permanentFailAdapter: EmailProviderAdapter = {
        name: 'fail-400',
        send: jest.fn(async () => {
          throw new ProviderDeliveryError('Invalid recipient', 400, false);
        }),
      };
      mail.setAdapter(permanentFailAdapter);

      const failReceipt = await mail.sendPasswordReset(
        'bad@foc.edu.ng',
        'tok-1',
      );
      expect(failReceipt.status).toBe('failed');
      expect(failReceipt.attempts).toBe(1);
      expect(failReceipt.errorCode).toBe('HTTP_400');

      // Rate limiting check: >5 requests for the same recipient + template within window
      for (let i = 0; i < 5; i++) {
        await mail.sendPasswordReset('ratelimit@foc.edu.ng', `tok-${i}`);
      }
      const rateLimited = await mail.sendPasswordReset(
        'ratelimit@foc.edu.ng',
        'tok-overflow',
      );
      expect(rateLimited.status).toBe('rate_limited');
      expect(rateLimited.errorCode).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('validates email and VAPID environment configuration outside test mode', () => {
      expect(() =>
        validateEmailAndPushConfig(
          {
            EMAIL_PROVIDER: 'resend',
            EMAIL_API_KEY: 'replace-with-key',
            EMAIL_FROM_ADDRESS: 'no-reply@foc.edu.ng',
          },
          'production',
        ),
      ).toThrow(/EMAIL_API_KEY/i);

      expect(() =>
        validateEmailAndPushConfig(
          {
            EMAIL_PROVIDER: 'console',
            WEB_PUSH_ENABLED: 'true',
            VAPID_PUBLIC_KEY: 'replace-me',
            VAPID_PRIVATE_KEY: 'valid-private-key-value',
            VAPID_SUBJECT: 'mailto:support@foc.edu.ng',
          },
          'production',
        ),
      ).toThrow(/VAPID_PUBLIC_KEY/i);
    });
  });

  describe('PushService & Web Push Dispatch', () => {
    const createPushPrismaMock = () => {
      const subs = new Map<string, any>();
      return {
        subs,
        user: {
          findUnique: jest.fn(async ({ where }: any) => ({
            id: where.id,
            role: where.id === 'hod-csc' ? Role.hod : Role.student,
            department: { code: 'CSC', name: 'Computer Science' },
          })),
        },
        pushSubscription: {
          findUnique: jest.fn(async ({ where }: any) => {
            if (where.endpoint) {
              return (
                Array.from(subs.values()).find(
                  (s) => s.endpoint === where.endpoint,
                ) || null
              );
            }
            return subs.get(where.id) || null;
          }),
          upsert: jest.fn(async ({ where, create, update }: any) => {
            const existing = Array.from(subs.values()).find(
              (s) => s.endpoint === where.endpoint,
            );
            const now = new Date();
            const record = existing
              ? { ...existing, ...update, updatedAt: now }
              : {
                  id: `sub-${subs.size + 1}`,
                  ...create,
                  createdAt: now,
                  updatedAt: now,
                };
            subs.set(record.id, record);
            return record;
          }),
          findMany: jest.fn(async ({ where }: any) => {
            return Array.from(subs.values()).filter((s) => {
              if (where?.userId && s.userId !== where.userId) return false;
              if (
                typeof where?.isActive === 'boolean' &&
                s.isActive !== where.isActive
              ) {
                return false;
              }
              if (
                typeof where?.urgentNotices === 'boolean' &&
                s.urgentNotices !== where.urgentNotices
              ) {
                return false;
              }
              return true;
            });
          }),
          update: jest.fn(async ({ where, data }: any) => {
            const existing = subs.get(where.id);
            const updated = { ...existing, ...data, updatedAt: new Date() };
            subs.set(where.id, updated);
            return updated;
          }),
          updateMany: jest.fn(async ({ where, data }: any) => {
            let count = 0;
            for (const [k, v] of subs.entries()) {
              if (v.userId === where.userId) {
                subs.set(k, { ...v, ...data, updatedAt: new Date() });
                count += 1;
              }
            }
            return { count };
          }),
          delete: jest.fn(async ({ where }: any) => {
            const existing = subs.get(where.id);
            subs.delete(where.id);
            return existing;
          }),
        },
      };
    };

    it('registers push subscriptions, prevents cross-user endpoint hijacking, and respects opt-out preferences', async () => {
      const prismaMock = createPushPrismaMock();
      const service = new PushService(prismaMock as any);

      const sub1 = await service.subscribe(
        { id: 'student-1' },
        {
          endpoint: 'https://fcm.googleapis.com/fcm/send/sub-token-1',
          keys: {
            p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQ',
            auth: 'tBHItJI5svbpez7KI4CCXg',
          },
          urgentNotices: true,
        },
      );

      expect(sub1.userId).toBe('student-1');
      expect(sub1.preferences.urgentNotices).toBe(true);

      // Reject non-HTTPS endpoint
      await expect(
        service.subscribe(
          { id: 'student-1' },
          {
            endpoint: 'http://insecure.example.com/push/1',
            keys: {
              p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQ',
              auth: 'tBHItJI5svbpez7KI4CCXg',
            },
          },
        ),
      ).rejects.toThrow(BadRequestException);

      // Prevent student-2 from hijacking or unsubscribing student-1's endpoint
      await expect(
        service.subscribe(
          { id: 'student-2' },
          {
            endpoint: 'https://fcm.googleapis.com/fcm/send/sub-token-1',
            keys: {
              p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQ',
              auth: 'tBHItJI5svbpez7KI4CCXg',
            },
          },
        ),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        service.unsubscribe(
          { id: 'student-2' },
          'https://fcm.googleapis.com/fcm/send/sub-token-1',
        ),
      ).rejects.toThrow(ForbiddenException);

      // Opt out of urgent notices
      const updatedPrefs = await service.updatePreferences(
        { id: 'student-1' },
        { urgentNotices: false },
      );
      expect(updatedPrefs.preferences.urgentNotices).toBe(false);
    });

    it('dispatches urgent notices to scoped subscribers, strips private student data, and removes expired 410 subscriptions', async () => {
      const prismaMock = createPushPrismaMock();
      const service = new PushService(prismaMock as any);

      // Seed two active subscriptions: one valid (201) and one expired (410 Gone)
      prismaMock.subs.set('sub-valid', {
        id: 'sub-valid',
        userId: 'student-csc',
        endpoint: 'https://fcm.googleapis.com/fcm/send/valid',
        p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQ',
        auth: 'tBHItJI5svbpez7KI4CCXg',
        urgentNotices: true,
        isActive: true,
        failureCount: 0,
        user: {
          id: 'student-csc',
          role: Role.student,
          status: UserStatus.active,
          level: 200,
          department: { code: 'CSC', name: 'Computer Science' },
          enrollments: [],
          lecturerOfferings: [],
        },
      });

      prismaMock.subs.set('sub-expired', {
        id: 'sub-expired',
        userId: 'student-csc-2',
        endpoint: 'https://fcm.googleapis.com/fcm/send/expired-410',
        p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQ',
        auth: 'tBHItJI5svbpez7KI4CCXg',
        urgentNotices: true,
        isActive: true,
        failureCount: 0,
        user: {
          id: 'student-csc-2',
          role: Role.student,
          status: UserStatus.active,
          level: 200,
          department: { code: 'CSC', name: 'Computer Science' },
          enrollments: [],
          lecturerOfferings: [],
        },
      });

      const sentPayloads: any[] = [];
      const customAdapter: PushProviderAdapter = {
        name: 'test-vapid',
        sendNotification: jest.fn(async (target, payload) => {
          sentPayloads.push({ target, payload });
          if (target.endpoint.includes('expired-410')) {
            return { statusCode: 410 };
          }
          return { statusCode: 201 };
        }),
      };
      service.setAdapter(customAdapter);

      const dispatchRes = await service.dispatchUrgentNotice({
        id: 'notice-urgent-1',
        title: 'Emergency Venue Change for CSC/2022/084',
        body: 'Contact amina.bello@foc.edu.ng or report to Hall B immediately.',
        scope: AudienceScope.department,
        targetDepartmentCode: 'CSC',
        isUrgent: true,
      });

      expect(dispatchRes.sentCount).toBe(1);
      expect(dispatchRes.removedExpiredCount).toBe(1);
      expect(prismaMock.subs.has('sub-expired')).toBe(false);

      // Verify private student matric number & email were scrubbed from push payload
      expect(sentPayloads[0].payload.title).not.toContain('CSC/2022/084');
      expect(sentPayloads[0].payload.body).not.toContain(
        'amina.bello@foc.edu.ng',
      );
      expect(sentPayloads[0].payload.url).toBe('/notices/notice-urgent-1');
    });

    it('enforces role and department authorization on push broadcast endpoint', async () => {
      const prismaMock = createPushPrismaMock();
      const service = new PushService(prismaMock as any);

      // Student cannot broadcast
      await expect(
        service.broadcast(
          { id: 'student-1', role: Role.student },
          {
            title: 'Fake Alert',
            body: 'School closed',
            scope: 'faculty',
          },
        ),
      ).rejects.toThrow(ForbiddenException);

      // HOD cannot broadcast faculty-wide or to another department
      await expect(
        service.broadcast(
          { id: 'hod-csc', role: Role.hod, departmentId: 'dept-csc' },
          {
            title: 'Dept Alert',
            body: 'For CYB',
            scope: 'department',
            targetDepartment: 'CYB',
          },
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
