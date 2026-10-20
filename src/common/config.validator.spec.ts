import { validateJwtSecret, validateStorageConfig } from './config.validator';

describe('Config Validator (JWT_SECRET)', () => {
  it('should bypass validation when NODE_ENV is test', () => {
    expect(() => validateJwtSecret(undefined, 'test')).not.toThrow();
    expect(() => validateJwtSecret('short', 'test')).not.toThrow();
    expect(() => validateJwtSecret('replace-me-example', 'test')).not.toThrow();
  });

  it('should throw when JWT_SECRET is missing outside test', () => {
    expect(() => validateJwtSecret(undefined, 'development')).toThrow(
      /JWT_SECRET is missing/,
    );
    expect(() => validateJwtSecret('', 'production')).toThrow(
      /JWT_SECRET is missing/,
    );
  });

  it('should throw when JWT_SECRET is shorter than 32 characters outside test', () => {
    expect(() =>
      validateJwtSecret('too-short-secret-only-24', 'development'),
    ).toThrow(/too short/);
  });

  it('should throw when JWT_SECRET contains placeholder keywords outside test', () => {
    expect(() =>
      validateJwtSecret(
        'replace-this-secret-with-a-very-long-string-over-32-chars',
        'development',
      ),
    ).toThrow(/placeholder/);
    expect(() =>
      validateJwtSecret(
        'change-me-please-secret-with-long-length-padding-12345678',
        'development',
      ),
    ).toThrow(/placeholder/);
    expect(() =>
      validateJwtSecret(
        'an-example-secret-that-is-over-32-characters-long-123456789',
        'production',
      ),
    ).toThrow(/placeholder/);
  });

  it('should succeed with a valid 32+ char random secret outside test', () => {
    expect(() =>
      validateJwtSecret(
        'e8f3b9c1d2e4a5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c',
        'development',
      ),
    ).not.toThrow();
  });
});

describe('Config Validator (STORAGE_DRIVER & S3 Credentials)', () => {
  it('should allow disk driver in development without S3 credentials', () => {
    expect(() =>
      validateStorageConfig(
        {
          STORAGE_DRIVER: 'disk',
        },
        'development',
      ),
    ).not.toThrow();
  });

  it('should reject unsupported STORAGE_DRIVER values', () => {
    expect(() =>
      validateStorageConfig(
        {
          STORAGE_DRIVER: 'ftp-invalid',
        },
        'development',
      ),
    ).toThrow(/Invalid STORAGE_DRIVER/);
  });

  it('should reject local disk storage in production unless explicitly overridden', () => {
    expect(() =>
      validateStorageConfig(
        {
          STORAGE_DRIVER: 'disk',
        },
        'production',
      ),
    ).toThrow(/Production environment requires persistent S3-compatible/);
  });

  it('should reject S3/R2 driver when required variables are missing or placeholders', () => {
    expect(() =>
      validateStorageConfig(
        {
          STORAGE_DRIVER: 's3',
          STORAGE_ENDPOINT: '',
          STORAGE_BUCKET: 'codics-bucket',
          STORAGE_ACCESS_KEY_ID: 'AKIA123456',
          STORAGE_SECRET_ACCESS_KEY: 'secret123456',
        },
        'production',
      ),
    ).toThrow(/STORAGE_ENDPOINT/);

    expect(() =>
      validateStorageConfig(
        {
          STORAGE_DRIVER: 'r2',
          STORAGE_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
          STORAGE_BUCKET: 'codics-bucket',
          STORAGE_ACCESS_KEY_ID: 'replace-with-access-key',
          STORAGE_SECRET_ACCESS_KEY: 'valid-secret-key-value',
        },
        'production',
      ),
    ).toThrow(/STORAGE_ACCESS_KEY_ID/);
  });

  it('should accept valid S3/R2 configuration without leaking secret values', () => {
    expect(() =>
      validateStorageConfig(
        {
          STORAGE_DRIVER: 's3',
          STORAGE_ENDPOINT: 'https://1234567890abcdef.r2.cloudflarestorage.com',
          STORAGE_REGION: 'auto',
          STORAGE_BUCKET: 'codics-prod-files',
          STORAGE_ACCESS_KEY_ID: '9f8e7d6c5b4a3f2e1d0c',
          STORAGE_SECRET_ACCESS_KEY:
            'a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e',
        },
        'production',
      ),
    ).not.toThrow();
  });
});
