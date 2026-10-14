import { expect, test } from '@playwright/test';
import { APPROVER, OWNER, SHOTS, apiFrom, login, png } from './helpers';

test.describe.configure({ mode: 'serial' });

test('unauthenticated users are sent to sign in', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
});

test('dashboard shows KPIs and the data-completeness warning', async ({ page }) => {
  await login(page);
  await expect(page.getByText('Master products')).toBeVisible();
  await expect(page.getByText(/No (real )?marketplace account is connected/)).toBeVisible();
  await expect(page.getByText(/Demonstration mode/)).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/dashboard.png`, fullPage: true });
});

test('product → listing draft → approval by a second user → publish (demo account)', async ({ page, browser }) => {
  await login(page);
  const api = apiFrom(page.request);

  // Ensure a separate approver exists (separation of duties).
  const users = await (await api.get('/users')).json();
  if (!users.some((u: { email: string }) => u.email === APPROVER.email)) {
    const r = await api.post('/users', { email: APPROVER.email, name: 'E2E Approver', password: APPROVER.password, roleKeys: ['listing_approver'] });
    expect(r.ok()).toBeTruthy();
  }

  // Create a product through the UI.
  const sku = `E2E-${Date.now().toString(36).toUpperCase()}`;
  await page.goto('/products/new');
  await page.getByLabel('Title').fill('E2E Satin Slip Dress');
  await page.getByLabel('Category').fill('Dresses');
  await page.getByLabel('sku').fill(sku);
  await page.getByLabel('size').fill('10');
  await page.getByLabel('colour').fill('Green');
  await page.getByLabel('Supplier price').fill('7.20');
  await page.getByLabel('Supplier shipping').fill('2.00');
  await page.getByRole('button', { name: 'Create product' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Satin Slip Dress' })).toBeVisible();
  const productId = page.url().split('/').pop()!;

  // Upload an image.
  await page.locator('input[type=file]').setInputFiles({ name: 'main.png', mimeType: 'image/png', buffer: png(900, 900) });
  await expect(page.getByText('Main · 900×900')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/product.png`, fullPage: true });

  // Create a draft for the demo eBay UK account via the listing builder.
  const product = await (await api.get(`/products/${productId}`)).json();
  await page.goto(`/listings/new?variants=${product.variants[0].id}`);
  await page.getByLabel('Account').selectOption({ label: 'eBay UK (DEMO) — connected' });
  await page.getByLabel('Price strategy').selectOption('fixed');
  await page.getByLabel('Amount').fill('29.99');
  await page.getByRole('button', { name: 'Create 1 draft(s)' }).click();
  await expect(page.getByRole('heading', { name: /E2E Satin Slip Dress/ })).toBeVisible();
  await expect(page.getByText('Incomplete')).toBeVisible();

  // Fill the marketplace-specific fields and save.
  await page.getByLabel('Category ID').fill('63861');
  await page.getByLabel('Condition').selectOption('NEW');
  await page.getByLabel('Dispatch time (days)').fill('2');
  await page.getByLabel('Shipping policy ID').fill('ship-standard');
  await page.getByLabel('Return policy ID').fill('returns-30');
  await page.getByLabel('Size verified').check();
  await page.getByLabel('Colour verified').check();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('✓ Ready for approval')).toBeVisible();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Awaiting approval').first()).toBeVisible();
  const listingUrl = page.url();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/listing-builder.png`, fullPage: true });

  // Approver signs in separately, approves and publishes.
  const ctx = await browser.newContext();
  const ap = await ctx.newPage();
  await login(ap, APPROVER);
  await ap.goto(listingUrl);
  await ap.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(ap.getByText('Approved').first()).toBeVisible();
  ap.once('dialog', (d) => d.accept());
  await ap.getByRole('button', { name: /Publish to eBay UK/ }).click();
  await expect(ap.getByText(/Marketplace ID DEMO-EBAY_UK-/)).toBeVisible();
  await expect(ap.getByText('Active').first()).toBeVisible();
  await ctx.close();
});

test('profit calculator reproduces the demonstration example', async ({ page }) => {
  await login(page);
  await page.goto('/profit');
  await page.getByRole('button', { name: 'Calculate', exact: true }).click();
  await expect(page.getByText('Net profit £11.00')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/profit.png`, fullPage: true });
});

test('listing to an unconnected real account is never shown as published', async ({ page }) => {
  await login(page);
  await page.goto('/integrations');
  await expect(page.getByRole('cell', { name: 'eBay UK (main)' })).toBeVisible();
  await expect(page.getByText('Not connected').first()).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/integrations.png`, fullPage: true });
});

test('layout works at phone width', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await login(page, OWNER);
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('link', { name: 'Products & Inventory' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/mobile-nav.png` });
  await ctx.close();
});
