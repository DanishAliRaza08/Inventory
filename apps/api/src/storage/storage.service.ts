import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { dirname, join, normalize } from 'path';
import { config } from '../config';

/**
 * Object storage abstraction. The local-disk driver is used in development and tests; an
 * S3-compatible driver (same interface) is used in staging/production.
 */
@Injectable()
export class StorageService {
  private root() {
    return normalize(config().UPLOAD_DIR);
  }

  async put(prefix: string, ext: string, data: Buffer): Promise<{ key: string; sha256: string; size: number }> {
    const key = `${prefix}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}.${ext}`;
    const path = this.pathFor(key);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, data);
    return { key, sha256: createHash('sha256').update(data).digest('hex'), size: data.length };
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.pathFor(key));
  }

  async delete(key: string) {
    await fs.rm(this.pathFor(key), { force: true });
  }

  private pathFor(key: string) {
    if (key.includes('..') || key.startsWith('/')) throw new Error('Invalid storage key');
    return join(this.root(), key);
  }
}
