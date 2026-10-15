import { isValidPassword } from './password.util';

describe('Password Rules Utility', () => {
  it('should accept passwords with at least 8 characters, 1 uppercase, and 1 number', () => {
    expect(isValidPassword('Password123')).toBe(true);
    expect(isValidPassword('Str0ngPass!')).toBe(true);
    expect(isValidPassword('ABCDEF1a')).toBe(true);
  });

  it('should reject passwords shorter than 8 characters', () => {
    expect(isValidPassword('Pass1')).toBe(false);
    expect(isValidPassword('P1a')).toBe(false);
    expect(isValidPassword('')).toBe(false);
  });

  it('should reject passwords missing an uppercase letter', () => {
    expect(isValidPassword('password123')).toBe(false);
    expect(isValidPassword('lower_only_99')).toBe(false);
  });

  it('should reject passwords missing a number', () => {
    expect(isValidPassword('PasswordOnly')).toBe(false);
    expect(isValidPassword('NoNumbersHere')).toBe(false);
  });

  it('should reject non-string inputs', () => {
    expect(isValidPassword(null)).toBe(false);
    expect(isValidPassword(undefined)).toBe(false);
    expect(isValidPassword(12345678)).toBe(false);
  });
});
