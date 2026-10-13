import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, AuthContext, RequirePermissions } from '../auth/decorators';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { InventoryService, InventorySettingsInput, MovementInput } from './inventory.service';

const CountBody = z.object({ counted: z.number().int().nonnegative(), reason: z.string().min(1).max(500) });

@ApiTags('Products & inventory')
@Controller('variants/:id/inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  @RequirePermissions('inventory.read')
  availability(@Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.availability(id);
  }

  @Get('movements')
  @RequirePermissions('inventory.read')
  movements(@Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.movements(id);
  }

  @Post('movements')
  @RequirePermissions('inventory.adjust')
  @ApiZodBody(MovementInput)
  move(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(MovementInput)) body: z.infer<typeof MovementInput>, @Auth() auth: AuthContext) {
    return this.inventory.move(id, body, auth);
  }

  @Post('count')
  @RequirePermissions('inventory.adjust')
  @ApiZodBody(CountBody)
  count(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(CountBody)) body: z.infer<typeof CountBody>, @Auth() auth: AuthContext) {
    return this.inventory.count(id, body.counted, body.reason, auth);
  }

  @Patch('settings')
  @RequirePermissions('inventory.adjust')
  @ApiZodBody(InventorySettingsInput)
  settings(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(InventorySettingsInput)) body: z.infer<typeof InventorySettingsInput>, @Auth() auth: AuthContext) {
    return this.inventory.updateSettings(id, body, auth);
  }
}
