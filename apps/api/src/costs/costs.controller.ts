import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, AuthContext, RequirePermissions } from '../auth/decorators';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { CostsService, NewCostRecord, NewCostRecordInput } from './costs.service';

@ApiTags('Costs')
@Controller()
export class CostsController {
  constructor(private readonly costs: CostsService) {}

  @Get('variants/:id/costs')
  @RequirePermissions('costs.read')
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.costs.history(id);
  }

  @Post('variants/:id/costs')
  @RequirePermissions('costs.write')
  @ApiZodBody(NewCostRecord)
  add(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(NewCostRecord)) body: NewCostRecordInput, @Auth() auth: AuthContext) {
    return this.costs.addCost(id, body, auth);
  }

  @Post('costs/:id/verify')
  @RequirePermissions('costs.write')
  verify(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    return this.costs.verify(id, auth);
  }

  @Get('costs/unverified')
  @RequirePermissions('costs.read')
  unverified(@Query('days') days?: string) {
    return this.costs.unverified(days ? Number(days) : undefined);
  }
}
