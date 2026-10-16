# CODICS Backend API

Production-ready NestJS + TypeScript backend for the CODICS academic portal. Built with PostgreSQL 16 and Prisma ORM 7.10.0.

Provides hardened JWT authentication, scoped role authorization, notice management with moderation, course management and syllabi, assignment submissions with disk storage, past question repository with upload permission workflows, student administration with one-time activation, and database-level audit logging.

---

## 1. Prerequisites

- **Node.js**: `v20.x` or `v24.x` (tested on Node `v24.15.0`)
- **npm**: `v10.x` or higher
- **PostgreSQL**: `v16.x` (local PostgreSQL instance or Docker container)

---

## 2. Local Setup & Quickstart

### Step 1: Clone and Install
```bash
git clone <repo-url>
cd codics-backend
npm install
```

### Step 2: Environment Configuration
Copy the template configuration file:
```bash
cp .env.example .env
```
Ensure your `.env` contains valid local database connection URLs:
```ini
NODE_ENV=development
PORT=3000
CORS_ORIGIN=http://localhost:3000,http://localhost:5173

# Local Database Connections (Port 5432 or 5433 depending on local Postgres setup)
DATABASE_URL=postgresql://codics:codics@127.0.0.1:5432/codics?schema=public
DIRECT_URL=postgresql://codics:codics@127.0.0.1:5432/codics?schema=public
TEST_DATABASE_URL=postgresql://codics:codics@127.0.0.1:5432/codics_test?schema=public

# Remote / Supabase Database Connections (optional, for deployment)
SUPABASE_DATABASE_URL=
SUPABASE_DIRECT_URL=

# Security & Secrets
# JWT_SECRET must be at least 32 characters (app will refuse to start outside test if insecure)
JWT_SECRET=your_96_character_random_hex_secret_here
DEMO_PASSWORD=CodicsDemo2026!
UPLOAD_DIR=./uploads
```

### Step 3: Start Local Database
If using Docker:
```bash
docker compose up -d
```
If using a native PostgreSQL installation, ensure `codics` and `codics_test` databases exist and the user has `CREATEDB` privileges.

### Step 4: Run Migrations and Seed
```bash
# Apply Prisma migrations to the local database
npm run db:migrate

# Seed demo departments, users, courses, and offerings
npm run db:seed
```

### Step 5: Start the Development Server
```bash
npm run start:dev
```

- API Base URL: `http://localhost:3000/api/v1`
- Swagger UI Documentation: `http://localhost:3000/docs`
- Health Check: `http://localhost:3000/api/v1/health`
- Database Health Check: `http://localhost:3000/api/v1/health/db`
- Public Server Time: `http://localhost:3000/api/v1/time`

---

## 3. Seeded Accounts & Credentials

When the database is seeded (`npm run db:seed`), all accounts are created using the password configured in `DEMO_PASSWORD` (default: `CodicsDemo2026!`):

| Role | Name | Identifier / Email | Notes |
| :--- | :--- | :--- | :--- |
| **Admin** | Prof. Florence Nnamdi (Dean) | `dean.computing@foc.edu.ng` / `FOC/A/001` | Full administrative access |
| **HOD** | Dr. Babatunde Adeleke | `hod.cs@foc.edu.ng` / `FOC/H/001` | Computer Science HOD |
| **Lecturer** | Dr. Chinedu Eze | `c.eze@foc.edu.ng` / `FOC/L/001` | Lecturer for CSC201 |
| **Course Rep** | Emmanuel Adeleke | `SEN/2022/012` | Active course rep (SEN) |
| **Student** | Chioma Okonkwo | `CSC/2022/084` | Active student (CSC Level 200) |
| **Unactivated Student** | Tunde Bakare | `IFT/2023/045` | Activation code generated in seed log |

---

## 4. Database Commands & Scripts

| Script | Command | Purpose |
| :--- | :--- | :--- |
| **Migrate Dev** | `npm run db:migrate` | Runs `prisma migrate dev` against local `DATABASE_URL` / `DIRECT_URL`. |
| **Seed Database** | `npm run db:seed` | Populates demo data using `prisma/seed.ts` (refuses in `production`). |
| **Deploy to Supabase** | `npm run db:deploy:supabase` | Runs `prisma migrate deploy` against `SUPABASE_DIRECT_URL`. Requires `CONFIRM_SUPABASE_DEPLOY=yes`. |
| **Prisma Studio** | `npx prisma studio` | Interactive database GUI browser. |

---

## 5. Security & Architecture Highlights

1. **Authentication & Password Security**:
   - Passwords hashed with `argon2id` (v0.14.x).
   - Password complexity enforced (>= 8 characters, at least 1 uppercase letter, at least 1 digit).
   - Startup validation refuses to start if `JWT_SECRET` is missing, shorter than 32 characters, or a placeholder.
   - Throttling enabled on authentication endpoints (`/auth/login`, `/auth/activate`, `/auth/refresh`) returning HTTP 429 with `Retry-After`.
2. **Account Activation**:
   - Student activation codes stored as Argon2 hashes in the `ActivationCode` table with 7-day expiration.
   - Single-use consumption invalidates the code upon activation.
3. **Session Management & Refresh Token Rotation**:
   - Opaque 64-character refresh tokens stored as SHA-256 hashes.
   - Automatic family rotation on refresh.
   - Immediate family-wide revocation if a previously rotated token is reused (token theft detection).
4. **File Storage**:
   - Files stored on local disk under `./uploads` using random UUID names.
   - Validates MIME types (PDF, PNG, JPG, DOCX) and max file sizes (15MB).
   - Authenticated file download endpoints stream files with permission checks.
5. **Database Protection**:
   - Row-Level Security (RLS) enabled on all 21 models in PostgreSQL.
   - Supabase `anon` and `authenticated` roles have all table privileges revoked; data is accessible exclusively via the backend service role.
   - `AuditLog` table protected by PostgreSQL triggers blocking `UPDATE`, `DELETE`, and `TRUNCATE`.
   - Course module deletion cascades soft-deletion (`deletedAt = now()`) to all contained materials.

---

## 6. Testing & Quality Assurance

```bash
# Code Style & Linting (ESLint flat config with zero warnings)
npm run lint

# Unit Test Suite (password rules, config validator, auth service)
npm test

# Full End-to-End Test Suite (database health, security, domain rules, moderation)
npm run test:e2e

# NestJS Production Build
npm run build
```

---

## 7. Branching Strategy

- `main`: Production release branch.
- `chore/prisma-setup`: Initial Prisma 7 configuration and verification.
- `feature/backend-hardening-postgres`: Implementation branch for Phase A (hardening) and Phase B (PostgreSQL migration and domain porting).
