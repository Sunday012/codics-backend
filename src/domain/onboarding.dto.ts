import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  DocReviewStatus,
  OnboardingDocType,
  OnboardingStatus,
} from '@prisma/client';

export class ApplyOnboardingDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9/]{8,20}$/, {
    message: 'jambRegNo must be a valid alphanumeric JAMB registration number (8-20 characters)',
  })
  jambRegNo!: string;

  @IsString()
  @IsNotEmpty()
  fullName!: string;

  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsString()
  @IsNotEmpty()
  departmentId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([100, 200])
  entryLevel?: number;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{4}\/\d{4}$/, {
    message: 'session must be in YYYY/YYYY format (e.g. 2025/2026)',
  })
  session!: string;
}

export class TrackOnboardingDto {
  @IsString()
  @IsNotEmpty()
  jambRegNo!: string;

  @IsString()
  @IsNotEmpty()
  applicationNumber!: string;
}

export class UploadOnboardingDocDto {
  @IsEnum(OnboardingDocType)
  documentType!: OnboardingDocType;

  @IsOptional()
  @IsString()
  title?: string;
}

export class ReviewApplicationDto {
  @IsString()
  @IsIn(['REQUEST_INFO', 'VERIFY_STEP', 'VERIFY_APPLICATION', 'REJECT'])
  action!: 'REQUEST_INFO' | 'VERIFY_STEP' | 'VERIFY_APPLICATION' | 'REJECT';

  @IsOptional()
  @IsString()
  documentId?: string;

  @IsOptional()
  @IsEnum(DocReviewStatus)
  docStatus?: DocReviewStatus;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class ConvertApplicationDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z]{3}\/\d{4}\/\d{3,5}$/, {
    message: 'matricNo must follow the faculty format (e.g. CSC/2026/042)',
  })
  matricNo!: string;
}

export class GuideStepDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  order!: number;

  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsOptional()
  @IsString()
  officialPortalUrl?: string;

  @IsOptional()
  @IsString()
  warning?: string;

  @IsOptional()
  @IsString()
  category?: string;
}

export class UpdateRegistrationGuideDto {
  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsString()
  @IsNotEmpty()
  session!: string;

  @IsOptional()
  @IsString()
  targetDepartmentCode?: string;

  @IsArray()
  steps!: GuideStepDto[];

  @IsOptional()
  @IsString()
  importantNotice?: string;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

export class QueryApplicationsDto {
  @IsOptional()
  @IsEnum(OnboardingStatus)
  status?: OnboardingStatus;

  @IsOptional()
  @IsString()
  departmentId?: string;

  @IsOptional()
  @IsString()
  session?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
