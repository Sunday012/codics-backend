import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
import {
  SyncMaterialProgressBatchDto,
  UpdateMaterialProgressDto,
} from './progress.dto';
import { ProgressService } from './progress.service';

@ApiTags('progress')
@ApiBearerAuth()
@Controller()
export class ProgressController {
  constructor(private readonly progress: ProgressService) {}

  @Get('progress')
  getMyProgress(@CurrentUser() user: any) {
    return this.progress.getUserProgress(user);
  }

  @Get('offerings/:id/progress')
  getOfferingProgress(@CurrentUser() user: any, @Param('id') id: string) {
    return this.progress.getOfferingProgress(user, id);
  }

  @Patch('materials/:id/progress')
  updateMaterialProgress(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateMaterialProgressDto,
  ) {
    return this.progress.updateMaterialProgress(user, id, dto);
  }

  @Post('progress/sync')
  syncBatch(
    @CurrentUser() user: any,
    @Body() dto: SyncMaterialProgressBatchDto,
  ) {
    return this.progress.syncProgressBatch(user, dto);
  }
}
