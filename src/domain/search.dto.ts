import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const SEARCH_ENTITY_TYPES = [
  'all',
  'course',
  'lesson',
  'notice',
  'past_question',
  'assignment',
  'calendar',
  'staff',
] as const;

export type SearchEntityTypeFilter = (typeof SEARCH_ENTITY_TYPES)[number];

export class GlobalSearchQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @IsOptional()
  @IsString()
  @IsIn(SEARCH_ENTITY_TYPES as unknown as string[])
  type?: SearchEntityTypeFilter;

  @IsOptional()
  @IsString()
  page?: string;

  @IsOptional()
  @IsString()
  limit?: string;
}
