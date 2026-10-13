import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, AuthContext, RequirePermissions } from '../auth/decorators';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../common/zod';
import { BulkUpdate, CreateProduct, ListProducts, SkuAliasBulk, UpdateProduct, UpdateVariant, VariantInput } from './products.schemas';
import { ProductsService } from './products.service';

@ApiTags('Products & inventory')
@Controller()
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get('search')
  search(@Query('q') q: string, @Auth() auth: AuthContext) {
    return this.products.globalSearch(q ?? '', auth.permissions);
  }

  @Get('products')
  @RequirePermissions('products.read')
  @ApiZodQuery(ListProducts)
  list(@Query(new ZodPipe(ListProducts)) q: z.infer<typeof ListProducts>) {
    return this.products.list(q);
  }

  @Get('products/duplicates')
  @RequirePermissions('products.read')
  duplicates() {
    return this.products.duplicates();
  }

  @Get('products/:id')
  @RequirePermissions('products.read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.get(id);
  }

  @Post('products')
  @RequirePermissions('products.write')
  @ApiZodBody(CreateProduct)
  create(@Body(new ZodPipe(CreateProduct)) body: z.infer<typeof CreateProduct>, @Auth() auth: AuthContext) {
    return this.products.create(body, auth);
  }

  @Patch('products/:id')
  @RequirePermissions('products.write')
  @ApiZodBody(UpdateProduct)
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateProduct)) body: z.infer<typeof UpdateProduct>, @Auth() auth: AuthContext) {
    return this.products.update(id, body, auth);
  }

  @Post('products/:id/archive')
  @RequirePermissions('products.delete')
  archive(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    return this.products.archive(id, auth);
  }

  @Post('products/bulk-update')
  @RequirePermissions('products.write')
  @ApiZodBody(BulkUpdate)
  bulkUpdate(@Body(new ZodPipe(BulkUpdate)) body: z.infer<typeof BulkUpdate>, @Auth() auth: AuthContext) {
    return this.products.bulkUpdate(body, auth);
  }

  @Post('products/:id/variants')
  @RequirePermissions('products.write')
  @ApiZodBody(VariantInput)
  addVariant(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(VariantInput)) body: z.infer<typeof VariantInput>, @Auth() auth: AuthContext) {
    return this.products.addVariant(id, body, auth);
  }

  @Patch('variants/:id')
  @RequirePermissions('products.write')
  @ApiZodBody(UpdateVariant)
  updateVariant(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateVariant)) body: z.infer<typeof UpdateVariant>, @Auth() auth: AuthContext) {
    return this.products.updateVariant(id, body, auth);
  }

  @Post('variants/sku-aliases')
  @RequirePermissions('products.write')
  @ApiZodBody(SkuAliasBulk)
  aliases(@Body(new ZodPipe(SkuAliasBulk)) body: z.infer<typeof SkuAliasBulk>, @Auth() auth: AuthContext) {
    return this.products.addSkuAliases(body, auth);
  }
}
