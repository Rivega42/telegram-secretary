/**
 * Тесты личного кабинета арендатора (self-serve): токен-авторизация,
 * изоляция (доступ только к своему), self-операции, выдача токена админом.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TMP = fs.mkdtempSync('/tmp/secretary-test-cabinet-');
process.env.STATE_DIR = TMP;
process.env.PERSONA_DIR = './persona';
process.env.OWNER_CHAT_ID = '1';
process.env.ONEINT_BOT_TOKEN = 'dummy';
process.env.API_KEY = 'user-key';
process.env.ADMIN_API_KEY = 'admin-key';
process.env.SECRETS_KEY = 'cab-key';
process.env.ROBOKASSA_MERCHANT_LOGIN = 'shop';
process.env.ROBOKASSA_PASSWORD1 = 'pw1';
process.env.ROBOKASSA_PASSWORD2 = 'pw2';

const { seedDefaultTenant, createTenant, issueCabinetToken, resolveTenantByCabinetToken } = await import('../src/core/tenant.js');
const { createApp } = await import('../src/app.js');

seedDefaultTenant();
createTenant({ id: 'alpha', name: 'Alpha', plan: 'free' });
createTenant({ id: 'beta', plan: 'pro' });

test('issueCabinetToken + резолв; токен случайный', () => {
  createTenant({ id: 'tok1', plan: 'free' });
  const a = issueCabinetToken('tok1');
  assert.equal(a.ok, true);
  assert.ok(a.token.length > 20);
  assert.equal(resolveTenantByCabinetToken(a.token).id, 'tok1');
  assert.equal(resolveTenantByCabinetToken('bad'), null);
  // перевыпуск меняет токен
  const a2 = issueCabinetToken('tok1');
  assert.notEqual(a2.token, a.token);
  assert.equal(resolveTenantByCabinetToken(a.token), null); // старый больше не валиден
});

let server, base, alphaTok, betaTok;
before(async () => {
  const app = createApp();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  alphaTok = issueCabinetToken('alpha').token;
  betaTok = issueCabinetToken('beta').token;
});
after(() => server?.close());

const cab = (tok, path, opts = {}) => fetch(`${base}/api/cabinet${path}`, {
  ...opts, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok, ...(opts.headers || {}) }
});

test('auth: без токена 401, с токеном — свой арендатор', async () => {
  assert.equal((await fetch(`${base}/api/cabinet`)).status, 401);
  assert.equal((await cab('nope', '')).status, 401);

  const r = await cab(alphaTok, '');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.tenant.id, 'alpha');     // ровно свой
  assert.ok(body.readiness && body.usage && Array.isArray(body.invoices));
});

test('изоляция: токен beta видит только beta', async () => {
  const body = await (await cab(betaTok, '')).json();
  assert.equal(body.tenant.id, 'beta');
  assert.equal(body.tenant.plan, 'pro');
});

test('self-персона: сохраняется своему арендатору', async () => {
  const r = await cab(alphaTok, '/persona', { method: 'POST', body: JSON.stringify({ base_md: 'Я Альфа-бот', facts_md: 'Факт' }) });
  assert.equal(r.status, 200);
  const body = await (await cab(alphaTok, '')).json();
  assert.equal(body.persona.base_md, 'Я Альфа-бот');
});

test('self-checkout: ссылка оплаты для своего арендатора', async () => {
  const r = await cab(alphaTok, '/billing/checkout', { method: 'POST', body: JSON.stringify({ plan: 'pro' }) });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.invoice.tenant_id, 'alpha');
  assert.ok(body.payment_url.startsWith('https://auth.robokassa.ru/'));
});

test('admin выдаёт токен кабинета; user-key запрещён', async () => {
  const ok = await fetch(`${base}/api/admin/tenants/beta/cabinet-token`, { method: 'POST', headers: { 'X-Api-Key': 'admin-key' } });
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).token);

  const denied = await fetch(`${base}/api/admin/tenants/beta/cabinet-token`, { method: 'POST', headers: { 'X-Api-Key': 'user-key' } });
  assert.equal(denied.status, 401);
});

test('статика кабинета отдаётся', async () => {
  const r = await fetch(`${base}/cabinet/cabinet.html`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Личный кабинет/);
});
