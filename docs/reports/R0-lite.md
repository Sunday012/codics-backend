# CODICS Backend R0-Lite & Phase A Hardening Report

**Date**: 2026-10-15  
**Branch**: `feature/backend-hardening-postgres`  
**Prisma Version**: `7.10.0` (pinned exact)  
**@prisma/client Version**: `7.10.0` (pinned exact)  
**Node.js**: `v24.15.0`  

---

## 1. Executive Summary

This report documents the completion of **Environment Setup** and **Phase A (Safety & Hardening Fixes)** of the CODICS backend modernization. All changes were implemented strictly on the application layer without modifying existing public API route paths or response contracts. No secret values from `.env` were exposed, logged, or committed.

All automated checks passed:
* **`npm run build`**: PASS (clean NestJS compilation)
* **`npm run lint`**: PASS (ESLint flat config, 0 warnings, 0 errors)
* **`npm test`**: PASS (3 test suites, 13 unit tests passed)
* **`npm run test:e2e`**: PASS (1 test suite, 8 e2e tests passed)

---

## 2. Environment Setup

1. **Backup**:
   * Created `.env.backup` from `.env`.
   * Verified `.gitignore` covers `.env`, `.env.*`, and `.env.backup`.
2. **Variable Normalization**:
   * Renamed pre-existing Supabase URLs to `SUPABASE_DATABASE_URL` and `SUPABASE_DIRECT_URL`.
   * Configured local PostgreSQL connection strings pointing to port `5433` (`codics` and `codics_test` databases).
   * Verified and generated a secure 96-character random hex `JWT_SECRET`.
   * Added `NODE_ENV=development`, random `DEMO_PASSWORD`, and `UPLOAD_DIR=./uploads`.
3. **Template Documentation**:
   * Updated `.env.example` with all configuration keys, safe placeholder values, and descriptive comments.

---

## 3. Phase A Implementations

### A1. JWT Hardening & Startup Refusal
* **Fallback Removal**: Removed `'development-secret-change-me'` from `AuthService` and `JwtAuthGuard`. Both classes now inject `JWT_SECRET` once during constructor initialization.
* **Startup Validation**: Implemented `validateEnvironment` in `src/common/config.validator.ts`. Outside `NODE_ENV === 'test'`, application bootstrap immediately throws an error and aborts if `JWT_SECRET` is:
  - Missing or empty
  - Shorter than 32 characters
  - A placeholder (matching `replace`, `change-me`, `example`)
* **Test Suite**: Unit tests in `src/common/config.validator.spec.ts` verify all rejection rules and confirm test bypass when `NODE_ENV === 'test'`.

### A2. Rate Limiting & Throttling
* **Package**: Installed `@nestjs/throttler` (v6.7.1).
* **Guards & Tracking**: Created `CustomThrottlerGuard` in `src/common/custom-throttler.guard.ts`.
  - Login tracked by `${IP}:${identifier}` (5 requests / minute).
  - Activation tracked by `${IP}:${matricNo}` (5 requests / minute).
  - Refresh token rotation (20 requests / minute).
  - Global default rate limit (100 requests / minute).
* **Header & Error Contract**: Returns HTTP `429 Too Many Requests` with a calculated `Retry-After` header.
* **E2E Test**: Added automated test in `test/app.e2e-spec.ts` confirming rapid login attempts trigger HTTP 429 with `Retry-After`.

### A3. Password Complexity Rules
* **Requirements**: Passwords must contain at least 8 characters, at least one uppercase letter (`[A-Z]`), and at least one number (`[0-9]`).
* **Implementation**: Created `isValidPassword` utility and `@IsStrongPasswordRules()` class-validator decorator in `src/common/password.util.ts`.
* **Application**: Applied to `ActivateDto` (and future registration/reset DTOs).
* **Test Suite**: Unit tests in `src/common/password.util.spec.ts` verify length and character composition rules.

### A4. Public Time Endpoint
* **Route**: `GET /api/v1/time` (and `GET /api/v1/health/time`).
* **Decorator**: Decorated with `@Public()` to bypass JWT authentication.
* **Response**: Returns `{ now: ISO 8601 string }` derived directly from the server clock.
* **E2E Test**: Verified unauthenticated access in `test/app.e2e-spec.ts`.

### A5. CORS Configuration
* **Implementation**: `src/main.ts` parses `CORS_ORIGIN` by splitting on commas, trimming whitespace, and filtering empty strings.
* **Flexibility**: Supports multiple origins (e.g. `http://localhost:5173,http://127.0.0.1:5173`) while maintaining `credentials: true`.

### A6. Repository Hygiene & Quality Controls
* **Git Hygiene**: Confirmed `.gitignore` ignores `data/`, `uploads/`, `.env`, `.env.*`, and `.env.backup`. Confirmed `data/codics.json` is not tracked.
* **Dependency Pinning**: Pinned `prisma` and `@prisma/client` strictly to `7.10.0` (removed `^` / `~`).
* **Linting & Formatting**: Installed ESLint 10, Prettier, `@typescript-eslint` packages, and `eslint-config-prettier`. Added `eslint.config.mjs` and `.prettierrc`.
* **Request Logging**: Created `RequestLoggingMiddleware` in `src/common/request-logging.middleware.ts`. Assigns/forwards `X-Request-Id`, measures duration, and logs requests without ever printing passwords, tokens, or auth headers.
* **Safe Exception Filter**: Implemented `AllExceptionsFilter` in `src/common/all-exceptions.filter.ts`. Prevents stack traces, database schemas, or raw SQL queries from leaking to API consumers on unexpected runtime errors.
* **Unit Testing Setup**: Added `jest` configuration to `package.json` with `src` root and `*.spec.ts` pattern matching.
* **CI Automation**: Created `.github/workflows/ci.yml` defining full GitHub Actions pipeline (Postgres 16 service, dependencies, lint, build, unit test, e2e test).

---

## 4. Verification & Test Metrics

```text
> npm run lint
eslint "{src,apps,libs,test}/**/*.ts" --max-warnings=0
✔ 0 errors, 0 warnings

> npm run build
nest build
✔ Success

> npm test
PASS src/auth/auth.service.spec.ts
PASS src/common/password.util.spec.ts
PASS src/common/config.validator.spec.ts
✔ 3 test suites, 13 tests passed

> npm run test:e2e
PASS test/app.e2e-spec.ts
✔ 1 test suite, 8 tests passed
```

---

## 5. Next Phase Status

Execution is halted at Phase A completion per protocol. Ready to proceed to **Phase B: Postgres via Prisma 7.10.0** once local PostgreSQL is ready.
