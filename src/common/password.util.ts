import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

export function isValidPassword(password: unknown): boolean {
  if (typeof password !== 'string') return false;
  if (password.length < 8) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  return true;
}

export function IsStrongPasswordRules(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isStrongPasswordRules',
      target: object.constructor,
      propertyName: propertyName,
      options: {
        message:
          'Password must be at least 8 characters long, contain at least one uppercase letter and at least one number',
        ...validationOptions,
      },
      validator: {
        validate(value: unknown, _args: ValidationArguments) {
          return isValidPassword(value);
        },
      },
    });
  };
}
