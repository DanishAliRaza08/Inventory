import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, AuthContext, RequirePermissions } from '../auth/decorators';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import { AiAssistantService } from './ai-assistant.service';

const ListingSuggest = z.object({ instructions: z.string().max(2000).optional() });
const ReplySuggest = z.object({ message: z.string().min(1).max(5000) });

/** AI assistant: suggestions only. Nothing here changes a listing or sends a message. */
@ApiTags('AI assistant')
@Controller('ai')
export class AiController {
  constructor(
    private readonly ai: AiAssistantService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('status')
  @RequirePermissions('listings.read')
  status() {
    return this.ai.status();
  }

  @Post('listings/:id/suggest')
  @HttpCode(200)
  @RequirePermissions('listings.write')
  @ApiZodBody(ListingSuggest)
  suggestListing(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ListingSuggest)) body: z.infer<typeof ListingSuggest>, @Auth() auth: AuthContext) {
    return this.ai.suggestListing(id, auth, body.instructions);
  }

  @Post('images/:id/check')
  @HttpCode(200)
  @RequirePermissions('listings.write')
  checkImage(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    return this.ai.checkImage(id, auth);
  }

  @Post('products/:id/check-images')
  @HttpCode(200)
  @RequirePermissions('listings.write')
  async checkProductImages(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    const images = await this.prisma.productImage.findMany({ where: { productId: id }, orderBy: { position: 'asc' }, select: { id: true } });
    const out = [];
    for (const i of images) out.push(await this.ai.checkImage(i.id, auth));
    return out;
  }

  @Post('orders/:id/reply')
  @HttpCode(200)
  @RequirePermissions('orders.manage')
  @ApiZodBody(ReplySuggest)
  suggestReply(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReplySuggest)) body: z.infer<typeof ReplySuggest>, @Auth() auth: AuthContext) {
    return this.ai.suggestCustomerReply(id, body.message, auth);
  }
}
