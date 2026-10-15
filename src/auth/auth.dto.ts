import { IsEmail, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { IsStrongPasswordRules } from '../common/password.util';

export class LoginDto {
  @IsString()
  identifier!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

export class RefreshDto {
  @IsString()
  refreshToken!: string;
}

export class ActivateDto {
  @Matches(/^[A-Z]{2,4}\/\d{4}\/\d{3,4}$/i)
  matricNo!: string;

  @IsString()
  @MinLength(6)
  activationCode!: string;

  @IsString()
  @IsStrongPasswordRules()
  password!: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}
