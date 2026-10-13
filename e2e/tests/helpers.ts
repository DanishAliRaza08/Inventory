import { APIRequestContext, Page, expect } from '@playwright/test';
import { deflateSync } from 'zlib';

export const OWNER = { email: process.env.E2E_OWNER_EMAIL ?? 'owner@fashionrockstar.example', password: process.env.E2E_OWNER_PASSWORD ?? 'ChangeMe-Owner-2026' };
export const APPROVER = { email: 'e2e-approver@fashionrockstar.example', password: 'E2e-Approver-Pass-1' };
export const SHOTS = process.env.E2E_SHOTS_DIR;

export async function login(page: Page, who = OWNER) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

/** API calls from the test, through the web origin, as the logged-in page's session. */
export function apiFrom(request: APIRequestContext) {
  const h = { 'X-Requested-With': 'e2e' };
  return {
    get: (p: string) => request.get(`/api${p}`, { headers: h }),
    post: (p: string, data?: object) => request.post(`/api${p}`, { headers: h, data: data ?? {} }),
  };
}

export function png(width: number, height: number): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = 42 + ((x * 3) % 60);
      raw[o + 1] = 120;
      raw[o + 2] = 214 - ((y * 2) % 80);
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
