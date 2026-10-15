import { validateJwtSecret } from './config.validator';

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
