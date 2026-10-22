import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Role, StaffInvitationStatus } from '@prisma/client';

export class CreateStaffInvitationDto {
  @IsEmail({}, { message: 'A valid email address is required' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  email!: string;

  @IsString()
  @MinLength(2, { message: 'Full name must have at least 2 characters' })
  @MaxLength(100, { message: 'Full name must not exceed 100 characters' })
  fullName!: string;

  @IsIn([Role.lecturer, Role.hod, Role.admin], {
    message: 'Staff invitation role must be lecturer, hod, or admin',
  })
  role!: Role;

  @IsString()
  @IsNotEmpty({ message: 'Department ID is required' })
  departmentId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Custom message must not exceed 500 characters' })
  customMessage?: string;
}

export class AcceptStaffInvitationDto {
  @IsString()
  @MinLength(16, { message: 'Invalid or missing invitation token' })
  token!: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  @MaxLength(128, { message: 'Password must not exceed 128 characters' })
  password!: string;

  @IsOptional()
  @IsString()
  confirmPassword?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  staffId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  fullName?: string;
}

export class VerifyStaffInvitationDto {
  @IsString()
  @MinLength(16, { message: 'Invalid or missing invitation token' })
  token!: string;
}

export class ListStaffInvitationsQueryDto {
  @IsOptional()
  @IsString()
  departmentId?: string;

  @IsOptional()
  @IsIn(['pending', 'accepted', 'expired', 'revoked'] as StaffInvitationStatus[])
  status?: StaffInvitationStatus;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
