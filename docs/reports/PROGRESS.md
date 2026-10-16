# Codics Backend Hardening and Postgres Migration Progress

## Environment Setup
- [x] Copy `.env` to `.env.backup` (confirmed gitignored)
- [x] Rename `DATABASE_URL` / `DIRECT_URL` to `SUPABASE_*` in `.env`
- [x] Add local PostgreSQL defaults to `.env` (`DATABASE_URL`, `DIRECT_URL`, `TEST_DATABASE_URL`)
- [x] Ensure random 96-char hex `JWT_SECRET`, `NODE_ENV`, `DEMO_PASSWORD`, `UPLOAD_DIR` in `.env`
- [x] Update `.env.example` with all variable names and safe placeholders

## Phase A: Safety Fixes (Independent of Data Layer)
- [x] **A1. JWT Hardening**:
  - [x] Remove hardcoded `'development-secret-change-me'` fallback in `auth.service.ts` and `jwt-auth.guard.ts`
  - [x] Read `JWT_SECRET` once from config
  - [x] Refuse to start outside `NODE_ENV=test` if `JWT_SECRET` is missing, <32 chars, or placeholder
  - [x] Configure test-only secret in e2e setup
- [x] **A2. Throttling**:
  - [x] Install `@nestjs/throttler`
  - [x] Configure login 5/min per identifier + IP, activate 5/min, refresh 20/min
  - [x] Return 429 with `Retry-After` header
- [x] **A3. Password Rules**:
  - [x] Enforce >= 8 chars, at least one uppercase letter, at least one number
- [x] **A4. Public Time Endpoint**:
  - [x] Implement `GET /time` returning `{ now: ISO string }`
- [x] **A5. CORS Configuration**:
  - [x] Support comma-separated list of origins in `CORS_ORIGIN`
- [x] **A6. Hygiene & Quality**:
  - [x] Verify `data/`, `uploads/`, `.env`, `.env.backup` in `.gitignore` (untrack `data/codics.json` if tracked)
  - [x] Configure ESLint and Prettier with npm scripts (`npm run lint`, `npm run format`)
  - [x] Request logging with request ID (never logging passwords, tokens, or auth headers)
  - [x] Custom exception filter (never leaking stack traces or SQL)
  - [x] Unit test setup passing `npm test` (tests for rep-term expiry, password rules)
  - [x] GitHub Actions workflow with Postgres service container
- [x] Write `docs/reports/R0-lite.md`
- [x] Commit Phase A

## Phase B: Postgres via Prisma 7.10.0 (Native Local Postgres on 127.0.0.1:5432)
- [x] B0. Local docker-compose Postgres 16 config & PrismaService runtime proof (`GET /health/db`)
- [x] B1. Schema in `prisma/schema.prisma` (21 models, relations, indexes, enums)
- [x] B2. Migrations, append-only AuditLog trigger, RLS + revoke permissions
- [x] B3. Repository layer & services ported to Prisma
- [x] B4. Database-backed auth (ActivationCode, RefreshToken family/reuse, PasswordReset)
- [x] B5. Business rules (Past questions upload permission matrix, notice moderation)
- [x] B6. StorageService with local disk driver and download routes
- [x] B7. Environment-guarded seed (`prisma/seed.ts`)
- [x] B8. Migration scripts (`db:migrate`, `db:seed`, `db:deploy:supabase`)
- [x] B9. Full test suite (ported e2e + security/permission matrix tests)
- [x] Write `docs/reports/R1.md`
- [x] Commit Phase B

## Phase C: Apply to Supabase Dev (Post-Phase B)
- [ ] C1. Run `db:deploy:supabase` against Supabase dev project
- [ ] C2. Verification (RLS, privileges, audit trigger, runtime read/write)
- [ ] Write `docs/reports/FINAL.md`
