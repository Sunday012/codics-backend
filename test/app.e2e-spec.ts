import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

describe('CODICS API', () => {
  let app: INestApplication<App>;
  let studentToken: string;
  let lecturerToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATA_FILE = `./data/codics-e2e-${process.pid}.json`;
    process.env.JWT_SECRET = 'codics-e2e-secret-with-more-than-32-characters';
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    studentToken = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: 'CSC/2022/084', password: 'password123' })
    ).body.accessToken;
    lecturerToken = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: 'i.adeleke@foc.edu.ng', password: 'password123' })
    ).body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports health without authentication', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200)
      .expect(({ body }) => expect(body.status).toBe('ok'));
  });

  it('returns server time via GET /time without authentication', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/time').expect(200);
    expect(res.body.now).toBeDefined();
    expect(new Date(res.body.now).toISOString()).toBe(res.body.now);
  });

  it('logs in and protects private routes', async () => {
    expect(studentToken).toBeTruthy();
    await request(app.getHttpServer()).get('/api/v1/courses').expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/courses')
      .set('Authorization', `Bearer ${studentToken}`)
      .expect(200);
  });

  it('enforces administrative roles', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/dashboard')
      .set('Authorization', `Bearer ${studentToken}`)
      .expect(403);
  });

  it('prevents students from publishing notices', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/notices')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ title: 'No', content: 'Not permitted', category: 'general', scope: 'faculty' })
      .expect(403);
  });

  it('accepts a valid enrolled-student submission and exposes it only to assigned staff', async () => {
    const submission = await request(app.getHttpServer())
      .post('/api/v1/assignments/asg-csc301-1/submissions')
      .set('Authorization', `Bearer ${studentToken}`)
      .attach('file', Buffer.from('%PDF-1.4 test'), 'answer.pdf')
      .expect(201);
    expect(submission.body.currentVersion.sha256).toMatch(/^[a-f0-9]{64}$/);

    const staffView = await request(app.getHttpServer())
      .get('/api/v1/assignments/asg-csc301-1/submissions')
      .set('Authorization', `Bearer ${lecturerToken}`)
      .expect(200);
    expect(staffView.body).toHaveLength(1);
    expect(staffView.body[0].studentMatric).toBe('CSC/2022/084');
  });

  it('rejects disallowed submission file types', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/assignments/asg-csc301-1/submissions')
      .set('Authorization', `Bearer ${studentToken}`)
      .attach('file', Buffer.from('bad'), 'answer.exe')
      .expect(400);
  });

  it('throttles rapid login requests and returns 429 with Retry-After', async () => {
    const testIdentifier = 'rate-limit-test@foc.edu.ng';
    // Consume remaining allowance (login limit is 5 per minute)
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: testIdentifier, password: 'password123' });
    }
    const throttledRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: testIdentifier, password: 'password123' });

    expect(throttledRes.status).toBe(429);
    expect(throttledRes.headers['retry-after']).toBeDefined();
  });
});
