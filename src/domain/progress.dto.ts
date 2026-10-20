import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class UpdateMaterialProgressDto {
  @IsOptional()
  @IsBoolean()
  completed?: boolean;

  @IsOptional()
  @IsISO8601()
  lastAccessedAt?: string;

  @IsOptional()
  @IsISO8601()
  clientUpdatedAt?: string;
}

export class SyncMaterialProgressItemDto {
  @IsString()
  @IsNotEmpty()
  materialId!: string;

  @IsOptional()
  @IsBoolean()
  completed?: boolean;

  @IsOptional()
  @IsISO8601()
  lastAccessedAt?: string;

  @IsISO8601()
  clientUpdatedAt!: string;

  @IsOptional()
  @IsString()
  mutationId?: string;
}

export class SyncMaterialProgressBatchDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SyncMaterialProgressItemDto)
  items!: SyncMaterialProgressItemDto[];
}
