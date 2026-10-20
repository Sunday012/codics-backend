import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
import type { SafeUser } from '../common/user.util';
import { GlobalSearchQueryDto } from './search.dto';
import { SearchService } from './search.service';

@ApiTags('search')
@ApiBearerAuth()
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  search(@CurrentUser() user: SafeUser, @Query() query: GlobalSearchQueryDto) {
    return this.searchService.search(user, query);
  }
}
