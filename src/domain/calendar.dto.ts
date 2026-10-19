import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AudienceScope } from '@prisma/client';

export class CreateAcademicPeriodDto {
  @IsString()
  @IsNotEmpty()
  sessionId!: string;

  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(['orientation', 'registration', 'lectures', 'exams', 'break', 'holiday', 'other'])
  type!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'start must be YYYY-MM-DD' })
  start!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'end must be YYYY-MM-DD' })
  end!: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateAcademicPeriodDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsIn(['orientation', 'registration', 'lectures', 'exams', 'break', 'holiday', 'other'])
  type?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'start must be YYYY-MM-DD' })
  start?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'end must be YYYY-MM-DD' })
  end?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class CreateTimetableSlotDto {
  @IsString()
  @IsNotEmpty()
  offeringId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(7)
  weekday!: number;

  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'startTime must be HH:mm (24-hour)' })
  startTime!: string;

  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'endTime must be HH:mm (24-hour)' })
  endTime!: string;

  @IsString()
  @IsNotEmpty()
  venue!: string;

  @IsOptional()
  @IsString()
  @IsIn(['lecture', 'practical', 'tutorial'])
  kind?: string = 'lecture';
}

export class UpdateTimetableSlotDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(7)
  weekday?: number;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'startTime must be HH:mm (24-hour)' })
  startTime?: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'endTime must be HH:mm (24-hour)' })
  endTime?: string;

  @IsOptional()
  @IsString()
  venue?: string;

  @IsOptional()
  @IsIn(['lecture', 'practical', 'tutorial'])
  kind?: string;
}

export class CreateTimetableExceptionDto {
  @IsString()
  @IsNotEmpty()
  slotId!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  @IsString()
  @IsIn(['cancelled', 'moved'])
  kind!: string;

  @IsOptional()
  @IsString()
  newVenue?: string;

  @IsOptional()
  @IsString()
  newTime?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class CreateCalendarEventDto {
  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsString()
  @IsIn(['exam', 'event', 'meeting', 'other'])
  type!: string;

  @IsISO8601()
  start!: string;

  @IsISO8601()
  end!: string;

  @IsOptional()
  @IsBoolean()
  allDay?: boolean = false;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  courseId?: string;

  @IsOptional()
  @IsString()
  courseCode?: string;

  @IsOptional()
  @IsEnum(AudienceScope)
  scope?: AudienceScope = AudienceScope.faculty;

  @IsOptional()
  @IsString()
  targetDepartment?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  targetLevel?: number;
}

export class UpdateCalendarEventDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsIn(['exam', 'event', 'meeting', 'other'])
  type?: string;

  @IsOptional()
  @IsISO8601()
  start?: string;

  @IsOptional()
  @IsISO8601()
  end?: string;

  @IsOptional()
  @IsBoolean()
  allDay?: boolean;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  courseCode?: string;

  @IsOptional()
  @IsEnum(AudienceScope)
  scope?: AudienceScope;

  @IsOptional()
  @IsString()
  targetDepartment?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  targetLevel?: number;
}
