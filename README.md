# CODICS API

NestJS + TypeScript backend for the CODICS frontend. It provides JWT authentication, scoped authorization, notices, courses and materials, assignments and submissions, past-question moderation, enrollments, student administration, role terms, audit logs, and academic settings.

## Run locally

```bash
cp .env.example .env
npm install
npm run start:dev
```

- API base URL: `http://localhost:3000/api/v1`
- Swagger UI: `http://localhost:3000/docs`
- Health check: `http://localhost:3000/api/v1/health`

For development, every seeded account uses `password123`:

| Role | Identifier |
|---|---|
| Student | `CSC/2022/084` |
| Course representative | `SEN/2022/012` |
| Lecturer | `i.adeleke@foc.edu.ng` |
| HOD | `hod.cs@foc.edu.ng` |
| Admin | `dean.computing@foc.edu.ng` |

New invited student accounts use the development activation code `CODICS`. Replace that check with an email/SMS provider before production.

## Persistence

The starter writes atomically to `data/codics.json`, which keeps local setup dependency-free and data durable across restarts. Configure `DATA_FILE` to move it. For multi-instance production deployment, replace `DataService` with a transactional PostgreSQL repository and move uploaded files to object storage; domain services and controllers can remain unchanged.

## Security behavior

- Short-lived JWT access tokens and rotating, server-revocable refresh tokens
- bcrypt password and refresh-token hashes
- deny-by-default authenticated API with role guards
- HOD department scoping and course-offering lecturer scoping
- course-representative expiry fallback
- submission enrollment, extension/deadline, file type, file size and SHA-256 checks
- students can access only their own submissions; course reps receive headcounts without files
- last-admin protection and audit logging for privileged mutations

## Verification

```bash
npm run build
npm run test:e2e
```
