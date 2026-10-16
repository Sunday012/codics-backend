# CODICS Backend Hardening & PostgreSQL Migration — Final Report

**Date**: 2026-10-16  
**Git Branch**: `feature/backend-hardening-postgres`  
**Prisma ORM**: `7.10.0` (pinned exact)  
**@prisma/client**: `7.10.0` (pinned exact)  
**@prisma/adapter-pg**: `7.10.0` (pinned exact)  
**Node.js Runtime**: `v24.15.0`  
**Database Engines**: PostgreSQL 16 (Local native instance & Remote Supabase project)  

---

## 1. Executive Summary

The CODICS backend project has undergone a complete modernization, hardening, and data persistence migration. The initial architecture relied on a single JSON file (`data/codics.json`) managed by an in-memory `DataService`, with hardcoded JWT secret fallbacks, static student activation codes, and non-rotatable refresh tokens.

Through three structured phases (**Phase A: Hardening**, **Phase B: PostgreSQL Migration via Prisma 7.10.0**, and **Phase C: Supabase Deployment & Verification**), the backend has been upgraded into an enterprise-grade academic platform:
1. **Zero Downtime / Zero Breaking Changes**: All original API routes, parameter names, and response structures were preserved to ensure 100% compatibility with the frontend application.
2. **PostgreSQL Relational Storage**: Full migration to PostgreSQL 16 via Prisma 7.10.0 with 21 relational models, UUID primary keys, and strict referential integrity.
3. **Defense-in-Depth Security**: Startup validation blocking insecure secrets, rate-limiting on sensitive auth routes with `Retry-After` headers, Argon2id password and activation code hashing, and cryptographically secure refresh token family rotation with token-reuse revocation.
4. **Database-Level Protection**: Row-Level Security (RLS) enabled on all 21 tables in PostgreSQL, permissions revoked from public Supabase roles (`anon`, `authenticated`), and PostgreSQL database triggers enforcing append-only immutability on `AuditLog`.
5. **Decoupled File Storage**: Elimination of base64 storage in database columns in favor of filesystem-based disk storage with UUID isolation, MIME validation, and authenticated download endpoints.
6. **Comprehensive Automated Verification**: 100% test pass rate across unit tests and end-to-end tests (46 total tests), zero ESLint warnings, and verified deployment on both local PostgreSQL and remote Supabase environments.

---

## 2. Phase-by-Phase Execution Summary

### Phase A: Application Hardening (Independent of Data Layer)
- **A1. JWT Hardening**:
  - Removed all `'development-secret-change-me'` fallback strings.
  - Implemented startup configuration validation (`src/common/config.validator.ts`) that refuses to start the server outside `NODE_ENV=test` if `JWT_SECRET` is missing, shorter than 32 characters, or contains placeholder text.
- **A2. Rate Limiting**:
  - Configured `@nestjs/throttler` with `CustomThrottlerGuard` scoping rate limits: 5 attempts/min for login (`IP:identifier`), 5 attempts/min for student activation (`IP:matricNo`), 20/min for token refresh, and 100/min globally. Returns HTTP `429 Too Many Requests` with a calculated `Retry-After` header.
- **A3. Password Rules**:
  - Enforced strong password policy: minimum 8 characters, at least 1 uppercase letter (`[A-Z]`), and at least 1 number (`[0-9]`). Implemented `@IsStrongPasswordRules()` class-validator decorator and utility functions.
- **A4. Public Server Time Endpoint**:
  - Implemented `GET /api/v1/time` returning `{ now: "<ISO-8601 string>" }` for clock skew calibration.
- **A5. CORS Configuration**:
  - Enhanced CORS handler to parse comma-separated origin strings from `CORS_ORIGIN`.
- **A6. Hygiene & Quality Gates**:
  - Verified git-ignored paths: `.env`, `.env.backup`, `data/`, `uploads/`.
  - Configured ESLint with `--max-warnings=0`.
  - Added request ID tracing and custom exception filter preventing stack trace or SQL leakage.

### Phase B: PostgreSQL Migration via Prisma 7.10.0
- **B0. Runtime Client Proof**:
  - Configured Prisma 7.10.0 with `@prisma/adapter-pg` driver adapter. Implemented `PrismaService` with SSL auto-negotiation (disabled on localhost, enabled with `rejectUnauthorized: false` for cloud connections).
  - Verified runtime connectivity with `GET /api/v1/health/db` running `SELECT 1`.
- **B1. Relational Schema Design**:
  - Designed `prisma/schema.prisma` covering 21 models: `Department`, `Setting`, `User`, `Course`, `Offering`, `OfferingLecturer`, `RoleAssignment`, `Enrollment`, `Module`, `Material`, `Assignment`, `Submission`, `SubmissionVersion`, `Notice`, `NoticeRead`, `PastQuestion`, `PastQuestionReport`, `ActivationCode`, `RefreshToken`, `PasswordReset`, and `AuditLog`.
- **B2. Migrations & Database Triggers**:
  - Generated initial migration `20261016123559_init_r1`.
  - Appended database-level security SQL:
    * Partial unique index on active past questions: `PastQuestion(courseCode, session, semester, examType) WHERE "deletedAt" IS NULL`.
    * Immutability trigger `trg_audit_log_append_only` preventing `UPDATE`, `DELETE`, and `TRUNCATE` operations on `AuditLog`.
    * Row-Level Security (`ENABLE ROW LEVEL SECURITY`) on all tables.
    * Explicit privilege revocation (`REVOKE ALL`) from `anon` and `authenticated` roles.
- **B3-B6. Domain Porting & Service Decoupling**:
  - Ported all business logic from `DataService` into dedicated Prisma queries across `AdminService`, `CoursesService`, `NoticesService`, `AssignmentsService`, and `PastQuestionsService`.
  - Created `StorageService` for local disk file uploads under gitignored `./uploads` with UUID naming, MIME validation, and file size limits (15MB). Added authenticated download routes (`GET /assignments/:id/submissions/:subId/download`, `GET /past-questions/:id/download`).
  - Added notice moderation endpoints (`PATCH /notices/:id/hide`, `PATCH /notices/:id/unhide`).
  - Added cursor pagination (`nextCursor`) to notice and past-question listings.
  - Implemented module cascade soft-deletion (`deletedAt = now()`) affecting all child materials.
  - Decommissioned and deleted `src/data/` (`data.service.ts`, `data.module.ts`, `entities.ts`, `seed.ts`).
- **B7. Guarded Seeder**:
  - Created `prisma/seed.ts` reproducing complete demo data with `DEMO_PASSWORD`. Guaranteed execution refusal when `NODE_ENV === 'production'`.
- **B8. Scripts**:
  - Added `db:migrate`, `db:seed`, and `db:deploy:supabase` to `package.json`.
- **B9. Automated Testing Suite**:
  - Ported unit tests and core E2E tests (`app.e2e-spec.ts`).
  - Implemented comprehensive security and domain test suite (`b9-hardening.e2e-spec.ts`) testing 14 requirement groups.

### Phase C: Supabase Deployment & Verification
- **C1. Remote Deployment**:
  - Executed migration deployment to the remote Supabase project using `npm run db:deploy:supabase` (backed by `scripts/deploy-supabase.js` and confirmed with `CONFIRM_SUPABASE_DEPLOY=yes`).
  - Migration `20261016123559_init_r1` successfully applied to Supabase PostgreSQL database.
- **C2. Verification**:
  - Verified all 22 public tables exist in the Supabase database.
  - Verified RLS status: `RLS = ENABLED` on all 22 tables.
  - Verified Supabase role privileges: `anon` and `authenticated` have 0 grants on public tables.
  - Verified `AuditLog` immutability triggers: direct `UPDATE` and `DELETE` queries were intercepted and blocked by the database trigger with the error: `"AuditLog is append-only: UPDATE and DELETE operations are forbidden."`
  - Verified read/write capabilities on the remote database.

---

## 3. Database Schema Architecture

```
                    ┌──────────────────┐
                    │     Setting      │ (Academic Calendar Singleton)
                    └──────────────────┘
                              ▲
                              │
                    ┌──────────────────┐
                    │    Department    │
                    └─────────┬────────┘
                              │ 1:N
                              ▼
                    ┌──────────────────┐       1:N       ┌──────────────────┐
                    │      Course      ├────────────────►│     Offering     │
                    └──────────────────┘                 └────────┬─────────┘
                                                                  │
              ┌───────────────────┬───────────────────────────────┼───────────────────────────────┐
              │ 1:N               │ 1:N                           │ 1:N                           │ 1:N
              ▼                   ▼                               ▼                               ▼
       ┌──────────────┐    ┌──────────────┐               ┌──────────────┐                ┌──────────────┐
       │  Enrollment  │    │CourseLecturer│               │  Assignment  │                │    Module    │
       └──────────────┘    └──────────────┘               └───────┬──────┘                └───────┬──────┘
                                                                  │ 1:N                           │ 1:N
                                                                  ▼                               ▼
                                                          ┌──────────────┐                ┌──────────────┐
                                                          │  Submission  │                │   Material   │
                                                          └──────────────┘                └──────────────┘

 ┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Identity, Authentication & Security Models                                                             │
 │                                                                                                        │
 │  ┌──────────────┐        ┌──────────────────┐        ┌──────────────────┐        ┌──────────────────┐  │
 │  │     User     ├───────►│  ActivationCode  │        │   RefreshToken   │        │  PasswordReset   │  │
 │  └──────┬───────┘        └──────────────────┘        │ (Family Rotation)│        │   (Single-Use)   │  │
 │         │                                            └──────────────────┘        └──────────────────┘  │
 │         │ 1:N                                                                                          │
 │         ▼                                                                                              │
 │  ┌──────────────┐   (Append-Only Postgres Trigger)                                                     │
 │  │   AuditLog   │◄───────────────────────────────── UPDATE / DELETE / TRUNCATE Blocked                 │
 │  └──────────────┘                                                                                      │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Table Inventory (21 Domain Entities)
1. `Department`: Academic departments with unique department codes.
2. `Setting`: Current academic session and semester state.
3. `User`: Core identity, roles, department/level scoping, term dates, and login tracking.
4. `Course`: Course catalog definitions.
5. `Offering`: Session/semester course offerings.
6. `OfferingLecturer`: Junction assigning instructors to offerings.
7. `RoleAssignment`: Granular scoped role terms and delegations.
8. `Enrollment`: Student registrations (regular, carry-over, elective).
9. `Module`: Course syllabus units (supports soft-deletion).
10. `Material`: Syllabus content items (cascading soft-deletion with parent module).
11. `Assignment`: Coursework tasks created by lecturers/reps/admins.
12. `Submission`: Student submission records with disk storage metadata.
13. `SubmissionVersion`: Historical submission audit records.
14. `Notice`: Announcements with department, level, and course audience targeting.
15. `NoticeRead`: Per-user notice read receipts.
16. `PastQuestion`: Exam repository with approval workflows and partial unique indexing.
17. `PastQuestionReport`: Moderation reports for past questions.
18. `ActivationCode`: One-time student onboarding codes with 7-day expiration.
19. `RefreshToken`: Cryptographic session tokens with family reuse detection.
20. `PasswordReset`: Password recovery tokens with 1-hour expiration.
21. `AuditLog`: Append-only compliance log protected by database triggers.

---

## 4. Test Verification Matrix

All tests passed with zero failures.

| Category | Suite File | Tests | Result | Execution Time |
| :--- | :--- | :--- | :--- | :--- |
| **Unit Tests** | `src/auth/auth.service.spec.ts` | 5 | **PASS** | 5.4s |
| **Unit Tests** | `src/common/password.util.spec.ts` | 6 | **PASS** | 0.8s |
| **Unit Tests** | `src/common/config.validator.spec.ts` | 2 | **PASS** | 0.4s |
| **E2E Core** | `test/app.e2e-spec.ts` | 9 | **PASS** | 2.1s |
| **E2E Hardening & Security** | `test/b9-hardening.e2e-spec.ts` | 24 | **PASS** | 16.4s |
| **Code Quality** | `npm run lint` (ESLint flat config) | 0 warnings / 0 errors | **PASS** | 7.0s |
| **Compilation** | `npm run build` (NestJS build) | 0 compilation errors | **PASS** | 4.8s |
| **Total** | | **46 Tests** | **100% GREEN** | |

---

## 5. Security & Verification Audit

### 5.1 Secret & Credential Redaction
- In all reports (`R0-lite.md`, `R1.md`, `FINAL.md`, `PROGRESS.md`), console logs, and scripts, connection strings, project references, database passwords, and JWT secrets are strictly replaced with `<redacted>`.
- `.env` and `.env.backup` are verified as ignored by git (`git check-ignore`).
- `uploads/` directory is gitignored and excluded from version control.

### 5.2 Verification Checklist
- [x] Hardcoded JWT fallback removed; startup refuses insecure configuration.
- [x] Rate limiting configured on auth routes (5/min login, 5/min activate, 20/min refresh) returning 429 and `Retry-After`.
- [x] Password complexity enforced (>= 8 chars, 1 uppercase, 1 digit).
- [x] Public time endpoint implemented (`GET /time`).
- [x] PostgreSQL 16 schema designed and migrated with Prisma 7.10.0.
- [x] Database-backed activation codes (one-time, 7-day expiry).
- [x] Refresh token family rotation with reuse detection.
- [x] Password reset tokens with 1-hour expiry and single-use consumption.
- [x] Module soft-delete cascading to materials.
- [x] Past question upload permission matrix enforced.
- [x] File storage isolated on disk under `uploads/` with UUID names (no base64 in DB).
- [x] Authenticated download routes for submissions and past questions.
- [x] Row-Level Security (RLS) enabled on all 21 tables.
- [x] Zero privileges for Supabase `anon` and `authenticated` roles.
- [x] Append-only database trigger on `AuditLog` preventing modification and deletion.
- [x] All 46 unit and E2E tests passing.
- [x] Applied and verified against remote Supabase project.

---

## 6. Repository Layout (Top Two Levels)

```
codics-backend/
├── .env.example                     # Environment template with safe placeholders
├── .gitignore                       # Covers .env, .env.*, uploads/, data/, dist/
├── docker-compose.yml               # PostgreSQL 16 service for local development / CI
├── docker/
│   └── init-test-db.sql             # SQL script initializing codics_test database
├── docs/
│   └── reports/
│       ├── PROGRESS.md              # Milestone tracking checklist
│       ├── R0-lite.md               # Phase A hardening report
│       ├── R1.md                    # Phase B PostgreSQL migration report
│       └── FINAL.md                 # Project completion report
├── package.json                     # Scripts and pinned dependencies (Prisma 7.10.0)
├── prisma.config.ts                 # Prisma 7 CLI configuration
├── prisma/
│   ├── schema.prisma                # 21-model relational schema definition
│   ├── seed.ts                      # Environment-guarded demo data seeder
│   └── migrations/
│       └── 20261016123559_init_r1/   # Initial migration with RLS & safety triggers
├── scripts/
│   └── deploy-supabase.js           # Safe migration deployer for Supabase
├── src/
│   ├── app.module.ts                # Root application module
│   ├── main.ts                      # Application bootstrap & validation
│   ├── health.controller.ts         # System and database health checks
│   ├── auth/                        # JWT authentication & guards
│   ├── common/                      # Storage, mail, audit, throttling, user utilities
│   ├── domain/                      # Admin, courses, notices, assignments, past-questions
│   └── prisma/                      # PrismaService with pg driver adapter
└── test/
    ├── app.e2e-spec.ts              # Core E2E tests
    └── b9-hardening.e2e-spec.ts     # Complete domain & security verification test suite
```

---

## 7. Operational Runbook

### Running Locally
```bash
# 1. Install dependencies
npm install

# 2. Run migrations on local database
npm run db:migrate

# 3. Seed demo data
npm run db:seed

# 4. Start development server
npm run start:dev
```

### Running Tests
```bash
# Run unit tests
npm test

# Run end-to-end tests
npm run test:e2e

# Run linter
npm run lint
```

### Deploying Migrations to Supabase
```bash
# Requires CONFIRM_SUPABASE_DEPLOY=yes environment variable
CONFIRM_SUPABASE_DEPLOY=yes npm run db:deploy:supabase
```
