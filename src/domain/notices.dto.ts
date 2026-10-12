import { IsBoolean, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class NoticeDto {
  @IsString() @MinLength(3) title!: string;
  @IsString() @MinLength(3) content!: string;
  @IsIn(['academic', 'exam', 'event', 'urgent', 'general']) category!: 'academic' | 'exam' | 'event' | 'urgent' | 'general';
  @IsIn(['faculty', 'department', 'level', 'course']) scope!: 'faculty' | 'department' | 'level' | 'course';
  @IsOptional() @IsBoolean() isUrgent?: boolean;
  @IsOptional() @IsString() targetLevel?: string;
  @IsOptional() @IsString() targetDepartment?: string;
  @IsOptional() @IsString() courseCode?: string;
}

export class ModerateDto {
  @IsBoolean() hidden!: boolean;
  @IsOptional() @IsString() reason?: string;
}
