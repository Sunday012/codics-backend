# CODICS API

NestJS + TypeScript backend for the CODICS frontend. It provides JWT authentication, scoped authorization, notices, courses and materials, assignments and submissions, past-question moderation, enrollments, student administration, role terms, audit logs, and academic settings.

## Run locally

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:deploy
npm run db:seed
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

CODICS uses PostgreSQL through Prisma ORM. Set `DATABASE_URL` to the pooled/runtime PostgreSQL connection string. If a hosted provider supplies a separate direct connection, set `DIRECT_URL` for migrations.

```env
DATABASE_URL=postgresql://codics:codics@localhost:5433/codics?schema=public
```

The included Compose service exposes PostgreSQL on host port `5433` to avoid colliding with an existing local server. Schema migrations live in `prisma/migrations`, and seed data is idempotent.

```bash
npm run db:migrate   # create a development migration
npm run db:deploy    # apply committed migrations in production
npm run db:seed      # insert/update development seed data
npm run db:studio    # inspect the database
```

Submission bytes are currently stored in PostgreSQL `BYTEA`, protected by the same assignment privacy rules as the metadata. Large-scale deployments can replace this field with object-storage keys without changing the public API.

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

The end-to-end suite expects a migrated and seeded test database. Override its connection with `TEST_DATABASE_URL`.
