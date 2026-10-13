import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, AuthContext, RequirePermissions } from '../auth/decorators';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { PriceUpdate, StockObservation, SupplierInput, SupplierProductInput, SuppliersService } from './suppliers.service';

@ApiTags('Suppliers')
@Controller()
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get('suppliers')
  @RequirePermissions('suppliers.read')
  list() {
    return this.suppliers.list();
  }

  @Get('suppliers/:id')
  @RequirePermissions('suppliers.read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.suppliers.get(id);
  }

  @Post('suppliers')
  @RequirePermissions('suppliers.write')
  @ApiZodBody(SupplierInput)
  create(@Body(new ZodPipe(SupplierInput)) body: z.infer<typeof SupplierInput>, @Auth() auth: AuthContext) {
    return this.suppliers.create(body, auth);
  }

  @Patch('suppliers/:id')
  @RequirePermissions('suppliers.write')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(SupplierInput.partial())) body: Partial<z.infer<typeof SupplierInput>>, @Auth() auth: AuthContext) {
    return this.suppliers.update(id, body, auth);
  }

  @Post('variants/:id/suppliers')
  @RequirePermissions('suppliers.write')
  @ApiZodBody(SupplierProductInput)
  link(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(SupplierProductInput)) body: z.infer<typeof SupplierProductInput>, @Auth() auth: AuthContext) {
    return this.suppliers.linkVariant(id, body, auth);
  }

  @Post('supplier-products/:id/price')
  @RequirePermissions('suppliers.write', 'costs.write')
  @ApiZodBody(PriceUpdate)
  price(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(PriceUpdate)) body: z.infer<typeof PriceUpdate>, @Auth() auth: AuthContext) {
    return this.suppliers.updatePrice(id, body, auth);
  }

  @Get('supplier-products/:id/price-history')
  @RequirePermissions('costs.read')
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.suppliers.priceHistory(id);
  }

  @Post('supplier-products/:id/stock')
  @RequirePermissions('inventory.adjust')
  @ApiZodBody(StockObservation)
  stock(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(StockObservation)) body: z.infer<typeof StockObservation>, @Auth() auth: AuthContext) {
    return this.suppliers.recordStock(id, body, auth);
  }
}
