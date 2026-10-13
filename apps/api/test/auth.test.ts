import request from 'supertest';
import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, TestContext, login, setupApp } from './helpers';

let t: TestContext;
beforeAll(async () => {
  t = await setupApp();
});
afterAll(() => t.close());

describe('authentication', () => {
  it('rejects unauthenticated requests and wrong passwords', async () => {
    expect((await request(t.app.getHttpServer()).get('/api/products')).status).toBe(401);
    const bad = await request(t.app.getHttpServer()).post('/api/auth/login').set('X-Requested-With', 'x').send({ email: 'owner@test.local', password: 'nope' });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('requires the CSRF header on state-changing requests', async () => {
    const owner = await t.as('owner');
    const res = await request(t.app.getHttpServer()).post('/api/products').set('Cookie', owner.cookie).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF');
  });

  it('issues an httpOnly session cookie and returns permissions', async () => {
    const res = await request(t.app.getHttpServer()).post('/api/auth/login').set('X-Requested-With', 'x').send({ email: 'viewer@test.local', password: PASSWORD });
    expect(res.headers['set-cookie']![0]).toMatch(/HttpOnly/);
    const viewer = await t.as('viewer');
    const me = await viewer.get('/api/auth/me');
    expect(me.body.permissions).toContain('products.read');
    expect(me.body.permissions).not.toContain('products.write');
  });

  it('locks the account after repeated failures', async () => {
    for (let i = 0; i < 5; i++) {
      await request(t.app.getHttpServer()).post('/api/auth/login').set('X-Requested-With', 'x').send({ email: 'order_manager@test.local', password: 'wrong' });
    }
    const res = await request(t.app.getHttpServer()).post('/api/auth/login').set('X-Requested-With', 'x').send({ email: 'order_manager@test.local', password: PASSWORD });
    expect(res.body.code).toBe('ACCOUNT_LOCKED');
  });

  it('revokes the session on logout', async () => {
    const a = await login(t.app, 'finance_manager@test.local');
    expect((await a.get('/api/auth/me')).status).toBe(200);
    await a.post('/api/auth/logout');
    expect((await a.get('/api/auth/me')).status).toBe(401);
  });

  it('enrols and enforces TOTP multi-factor authentication', async () => {
    const a = await login(t.app, 'listing_approver@test.local');
    const setup = await a.post('/api/auth/mfa/setup');
    expect(setup.status).toBe(200);
    expect((await a.post('/api/auth/mfa/confirm', { code: '000000' })).status).toBe(401);
    expect((await a.post('/api/auth/mfa/confirm', { code: authenticator.generate(setup.body.secret) })).status).toBe(200);

    const b = await login(t.app, 'listing_approver@test.local');
    const blocked = await b.get('/api/listings');
    expect(blocked.status).toBe(401);
    expect(blocked.body.code).toBe('MFA_REQUIRED');
    expect((await b.post('/api/auth/mfa/verify', { code: authenticator.generate(setup.body.secret) })).status).toBe(200);
    expect((await b.get('/api/listings')).status).toBe(200);
  });
});

describe('authorisation (enforced on the backend)', () => {
  it('blocks actions outside the role', async () => {
    const viewer = await t.as('viewer');
    const res = await viewer.post('/api/products', { title: 'x', variants: [{ sku: 'X1' }] });
    expect(res.status).toBe(403);
    expect((await viewer.get('/api/users')).status).toBe(403);
    const lister = await t.as('listing_manager');
    expect((await lister.get('/api/expenses')).status).toBe(403);
    expect((await lister.put('/api/settings/controls.publishing_enabled', { value: false })).status).toBe(403);
  });

  it('only owners can grant the owner role, and owners cannot lock themselves out', async () => {
    const owner = await t.as('owner');
    const custom = await owner.put('/api/roles/user_admin', { name: 'User admin', permissions: ['users.manage'] });
    expect(custom.status).toBe(200);
    const res = await owner.post('/api/users', { email: 'ua@test.local', name: 'UA', password: PASSWORD, roleKeys: ['user_admin'] });
    expect(res.status).toBe(201);
    const ua = await login(t.app, 'ua@test.local');
    const grant = await ua.post('/api/users', { email: 'x@test.local', name: 'X', password: PASSWORD, roleKeys: ['owner'] });
    expect(grant.status).toBe(403);
    const me = await owner.get('/api/auth/me');
    expect((await owner.patch(`/api/users/${me.body.id}`, { status: 'DISABLED' })).body.code).toBe('SELF_LOCKOUT');
  });

  it('rejects weak passwords', async () => {
    const owner = await t.as('owner');
    const res = await owner.post('/api/users', { email: 'weak@test.local', name: 'W', password: 'short', roleKeys: ['viewer'] });
    expect(res.body.code).toBe('WEAK_PASSWORD');
  });
});
