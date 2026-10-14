import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { imageSize } from 'image-size';
import { memoryStorage } from 'multer';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { Auth, AuthContext, Public, RequirePermissions } from '../auth/decorators';
import { ImageUrlService } from '../storage/image-url.service';
import { ZodPipe } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

const ALLOWED = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
const Order = z.object({ imageIds: z.array(z.string().uuid()).min(1) });

@ApiTags('Products & inventory')
@Controller()
export class ImagesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly imageUrls: ImageUrlService,
  ) {}

  /** Signed, expiring public image URL for marketplaces to download (no session). */
  @Get('public/images/:imageId')
  @Public()
  async publicFile(@Param('imageId', ParseUUIDPipe) imageId: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) {
    if (!this.imageUrls.verify(imageId, exp ?? '', sig ?? '')) throw new ForbiddenException({ code: 'BAD_SIGNATURE', message: 'Invalid or expired image link.' });
    const img = await this.prisma.productImage.findUniqueOrThrow({ where: { id: imageId } });
    res.setHeader('Content-Type', `image/${img.format ?? 'jpeg'}`);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(await this.storage.get(img.storageKey));
  }

  @Post('products/:id/images')
  @RequirePermissions('listings.write')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } }))
  async upload(@Param('id', ParseUUIDPipe) productId: string, @UploadedFile() file: Express.Multer.File | undefined, @Auth() auth: AuthContext) {
    if (!file) throw new BadRequestException({ code: 'NO_FILE', message: 'Attach an image file as "file".' });
    let dims: { width?: number; height?: number; type?: string };
    try {
      dims = imageSize(file.buffer);
    } catch {
      throw new BadRequestException({ code: 'NOT_AN_IMAGE', message: 'The file is not a readable image.' });
    }
    const format = (dims.type ?? '').toLowerCase();
    if (!ALLOWED.has(format)) throw new BadRequestException({ code: 'IMAGE_FORMAT', message: `Unsupported image format ${format}.` });
    await this.prisma.product.findUniqueOrThrow({ where: { id: productId } });
    const stored = await this.storage.put(`products/${productId}`, format === 'jpeg' ? 'jpg' : format, file.buffer);
    const duplicate = await this.prisma.productImage.findFirst({ where: { productId, sha256: stored.sha256 } });
    const count = await this.prisma.productImage.count({ where: { productId } });
    const img = await this.prisma.productImage.create({
      data: {
        productId,
        storageKey: stored.key,
        url: '',
        position: count,
        isMain: count === 0,
        width: dims.width,
        height: dims.height,
        format: format === 'jpg' ? 'jpeg' : format,
        sizeBytes: stored.size,
        sha256: stored.sha256,
        source: 'UPLOAD',
      },
    });
    const withUrl = await this.prisma.productImage.update({ where: { id: img.id }, data: { url: `/api/files/images/${img.id}` } });
    await this.audit.record(auth, { action: 'image.upload', entityType: 'product', entityId: productId, after: { imageId: img.id, width: dims.width, height: dims.height } });
    return { ...withUrl, duplicateOf: duplicate?.id ?? null };
  }

  @Put('products/:id/images/order')
  @RequirePermissions('listings.write')
  async reorder(@Param('id', ParseUUIDPipe) productId: string, @Body(new ZodPipe(Order)) body: z.infer<typeof Order>, @Auth() auth: AuthContext) {
    const images = await this.prisma.productImage.findMany({ where: { productId } });
    if (images.length !== body.imageIds.length || !body.imageIds.every((id) => images.some((i) => i.id === id))) {
      throw new BadRequestException({ code: 'ORDER_MISMATCH', message: 'Provide every image id of the product exactly once.' });
    }
    await this.prisma.$transaction(body.imageIds.map((id, position) => this.prisma.productImage.update({ where: { id }, data: { position, isMain: position === 0 } })));
    await this.audit.record(auth, { action: 'image.reorder', entityType: 'product', entityId: productId, after: body.imageIds });
    return { ok: true };
  }

  @Delete('images/:imageId')
  @RequirePermissions('listings.write')
  async remove(@Param('imageId', ParseUUIDPipe) imageId: string, @Auth() auth: AuthContext) {
    const img = await this.prisma.productImage.delete({ where: { id: imageId } });
    await this.storage.delete(img.storageKey);
    await this.audit.record(auth, { action: 'image.delete', entityType: 'product', entityId: img.productId, before: img });
    return { ok: true };
  }

  @Get('files/images/:imageId')
  @RequirePermissions('products.read')
  async file(@Param('imageId', ParseUUIDPipe) imageId: string, @Res() res: Response) {
    const img = await this.prisma.productImage.findUniqueOrThrow({ where: { id: imageId } });
    res.setHeader('Content-Type', `image/${img.format ?? 'jpeg'}`);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(await this.storage.get(img.storageKey));
  }
}
