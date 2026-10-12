import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class StudentDto {
  @Matches(/^[A-Z]{2,4}\/\d{4}\/\d{3,4}$/i) matricNo!: string;
  @IsString() @MinLength(2) fullName!: string;
  @IsString() department!: string;
  @IsIn(['100', '200', '300', '400', '500', 'PG']) level!: '100' | '200' | '300' | '400' | '500' | 'PG';
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsIn(['invited', 'active', 'suspended']) status?: 'invited' | 'active' | 'suspended';
}
export class StatusDto { @IsIn(['invited', 'active', 'suspended']) status!: 'invited' | 'active' | 'suspended'; @IsOptional() @IsString() reason?: string; }
export class RoleAssignmentDto {
  @IsString() userId!: string; @IsIn(['course_rep', 'hod', 'admin']) role!: 'course_rep' | 'hod' | 'admin';
  @IsIn(['department', 'faculty', 'course', 'level']) scopeType!: 'department' | 'faculty' | 'course' | 'level';
  @IsString() scopeId!: string; @IsString() scopeName!: string; @IsString() validFrom!: string; @IsString() validTo!: string;
}
export class EnrollmentDto { @IsString() userId!: string; @IsIn(['regular', 'carryover', 'elective']) type!: 'regular' | 'carryover' | 'elective'; }
export class SettingsDto { @IsString() session!: string; @IsIn(['First Semester', 'Second Semester']) semester!: string; }
export class DepartmentDto { @IsOptional() @IsString() id?: string; @IsString() name!: string; @IsString() code!: string; @IsOptional() @IsBoolean() isActive?: boolean; }
