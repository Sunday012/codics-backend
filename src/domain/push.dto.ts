import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class PushSubscriptionKeysDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  p256dh!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  auth!: string;
}

export class PushSubscribeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  endpoint!: string;

  @ValidateNested()
  @Type(() => PushSubscriptionKeysDto)
  keys!: PushSubscriptionKeysDto;

  @IsOptional()
  @IsBoolean()
  urgentNotices?: boolean;

  @IsOptional()
  @IsBoolean()
  courseUpdates?: boolean;

  @IsOptional()
  @IsBoolean()
  assignmentReminders?: boolean;
}

export class PushUnsubscribeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  endpoint!: string;
}

export class UpdatePushPreferencesDto {
  @IsOptional()
  @IsBoolean()
  urgentNotices?: boolean;

  @IsOptional()
  @IsBoolean()
  courseUpdates?: boolean;

  @IsOptional()
  @IsBoolean()
  assignmentReminders?: boolean;
}

export class PushBroadcastDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  body!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  url?: string;

  @IsOptional()
  @IsIn(['faculty', 'department', 'level', 'course'])
  scope?: 'faculty' | 'department' | 'level' | 'course';

  @IsOptional()
  @IsString()
  targetDepartment?: string;

  @IsOptional()
  @IsString()
  targetLevel?: string;

  @IsOptional()
  @IsString()
  courseCode?: string;

  @IsOptional()
  @IsIn(['urgentNotices', 'courseUpdates', 'assignmentReminders'])
  category?: 'urgentNotices' | 'courseUpdates' | 'assignmentReminders';
}
