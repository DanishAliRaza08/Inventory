import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';

/**
 * Time-limited, signed public URLs for product images. Marketplaces (eBay picture URLs, Amazon
 * image locators, TikTok image upload) must download images without logging in.
 */
@Injectable()
export class ImageUrlService {
  private key() {
    return createHmac('sha256', Buffer.from(config().APP_ENCRYPTION_KEY, 'base64')).update('public-image-urls').digest();
  }

  sign(imageId: string, ttlSeconds = 30 * 86_400) {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = createHmac('sha256', this.key()).update(`${imageId}.${exp}`).digest('base64url');
    return `${config().PUBLIC_BASE_URL}/api/public/images/${imageId}?exp=${exp}&sig=${sig}`;
  }

  verify(imageId: string, exp: string, sig: string) {
    if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
    const expected = createHmac('sha256', this.key()).update(`${imageId}.${exp}`).digest();
    const given = Buffer.from(sig, 'base64url');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
