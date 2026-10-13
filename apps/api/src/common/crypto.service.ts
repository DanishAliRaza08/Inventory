import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { config } from '../config';

export interface EncryptedBlob {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

/** AES-256-GCM envelope for secrets at rest (marketplace tokens, MFA secrets). */
@Injectable()
export class CryptoService {
  private key(): Buffer {
    return Buffer.from(config().APP_ENCRYPTION_KEY, 'base64');
  }

  encrypt(plaintext: string): EncryptedBlob {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), keyVersion: 1 };
  }

  decrypt(blob: Omit<EncryptedBlob, 'keyVersion'>): string {
    const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.authTag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }

  /** Compact single-string form for small secrets stored in one column. */
  seal(plaintext: string): string {
    const b = this.encrypt(plaintext);
    return [b.keyVersion, b.iv, b.authTag, b.ciphertext].join('.');
  }

  unseal(sealed: string): string {
    const [, iv, authTag, ciphertext] = sealed.split('.');
    return this.decrypt({ iv: iv!, authTag: authTag!, ciphertext: ciphertext! });
  }

  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
