import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class UploadPaperDto {
  @IsString() courseId!: string;
  @IsString() courseCode!: string;
  @IsString() courseTitle!: string;
  @IsString() department!: string;
  @IsString() level!: '100' | '200' | '300' | '400' | '500' | 'PG';
  @IsString() session!: string;
  @IsIn(['First Semester', 'Second Semester']) semester!: 'First Semester' | 'Second Semester';
  @IsIn(['exam', 'test', 'quiz']) examType!: 'exam' | 'test' | 'quiz';
  @IsString() fileName!: string;
  @IsString() fileUrl!: string;
}

export class ReviewPaperDto { @IsOptional() @IsString() @MinLength(3) reason?: string; }
export class ReportPaperDto {
  @IsIn(['wrong_course', 'unreadable_scan', 'wrong_year', 'other']) reason!: string;
  @IsOptional() @IsString() note?: string;
}
