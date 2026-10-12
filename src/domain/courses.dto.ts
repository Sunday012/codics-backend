import { IsIn, IsInt, IsOptional, IsString, IsUrl, Min, MinLength } from 'class-validator';

export class ModuleDto {
  @IsString() @MinLength(2) title!: string;
  @IsInt() @Min(1) order!: number;
  @IsOptional() @IsInt() @Min(1) weekNumber?: number;
  @IsOptional() @IsString() description?: string;
}

export class MaterialDto {
  @IsString() @MinLength(2) title!: string;
  @IsIn(['pdf', 'slides', 'note', 'link']) type!: 'pdf' | 'slides' | 'note' | 'link';
  @IsString() @MinLength(1) contentOrUrl!: string;
  @IsOptional() @IsInt() @Min(0) fileSizeBytes?: number;
  @IsOptional() @IsIn(['draft', 'published']) status?: 'draft' | 'published';
}
