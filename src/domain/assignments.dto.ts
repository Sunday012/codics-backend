import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsDateString, IsInt, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class AssignmentDto {
  @IsString() courseId!: string;
  @IsString() offeringId!: string;
  @IsString() courseCode!: string;
  @IsString() department!: string;
  @IsString() level!: string;
  @IsString() @MinLength(3) title!: string;
  @IsString() instructions!: string;
  @IsDateString() dueDate!: string;
  @IsInt() @Min(1) totalMarks!: number;
  @IsArray() @IsString({ each: true }) allowedFileTypes!: string[];
  @IsInt() @Min(1) maxSizeBytes!: number;
  @IsBoolean() allowLate!: boolean;
  @IsOptional() @IsString() status?: 'draft' | 'published';
}

export class GradeDto {
  @Type(() => Number) @IsNumber() @Min(0) score!: number;
  @IsOptional() @IsString() feedback?: string;
}

export class ExtendDeadlineDto {
  @IsDateString() dueDate!: string;
  @IsOptional() @IsString() studentId?: string;
  @IsOptional() @IsString() reason?: string;
}
