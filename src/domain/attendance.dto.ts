import {
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum AttendanceSessionStatusDto {
  OPEN = 'open',
  CLOSED = 'closed',
}

export enum AttendanceRecordStatusDto {
  PRESENT = 'present',
  LATE = 'late',
  ABSENT = 'absent',
  EXCUSED = 'excused',
}

export class CreateAttendanceSessionDto {
  @IsString()
  @IsNotEmpty()
  offeringId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(60)
  lateAfterMin?: number = 15;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(360)
  durationMin?: number = 60;

  @IsOptional()
  @Type(() => Number)
  @IsIn([30, 60])
  rotateSec?: number = 30;
}

export class CheckInDto {
  @IsString()
  @IsNotEmpty()
  sessionId!: string;

  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsOptional()
  @IsString()
  studentId?: string;
}

export class ManualAttendanceRecordDto {
  @IsString()
  @IsNotEmpty()
  sessionId!: string;

  @IsString()
  @IsNotEmpty()
  studentId!: string;

  @IsEnum(AttendanceRecordStatusDto)
  status!: AttendanceRecordStatusDto;

  @IsString()
  @IsNotEmpty()
  reason!: string;
}

export class AdjustAttendanceRecordDto {
  @IsEnum(AttendanceRecordStatusDto)
  toStatus!: AttendanceRecordStatusDto;

  @IsString()
  @IsNotEmpty()
  reason!: string;
}
