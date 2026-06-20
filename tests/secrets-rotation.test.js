/**
 * Тесты ротации ключа шифрования секретов (KMS-style, env-версии ключей).
 * Сценарий: ключ A → окно (primary B, old A) → reencrypt → только B.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TMP = fs.mkdtempSync('/tmp/secretary-test-rotation-');
process.env.STATE_DIR = TMP;
process.env.PERSONA_DIR = './persona';
process.env.OWNER_CHAT_ID = '1';
process.env.ONEINT_BOT_TOKEN = 'dummy';
process.env.ADMIN_API_KEY = 'admin-key';
process.env.SECRETS_KEY = 'KEY-A';                 // стартовый ключ
delete process.env.SECRETS_KEYS_OLD;

const { seedDefaultTenant, createTenant, setTenantSecret, getTenantSecret,
        resolveTenantByWebhookSecret, reencryptSecrets } = await import('../src/core/tenant.js');
const { createApp } = await import('../src/app.js');

seedDefaultTenant();
createTenant({ id: 'rot', plan: 'pro' });

test('старт: шифрование ключом A, чтение и резолв работают', () => {
  setTenantSecret('rot', 'tg_bot_token', 'botA');
  setTenantSecret('rot', 'tg_webhook_secret', 'whA');
  assert.equal(getTenantSecret('rot', 'tg_bot_token'), 'botA');
  assert.equal(resolveTenantByWebhookSecret('whA').id, 'rot');
});

test('окно ротации: primary=B, old=A — старые секреты читаются и резолвятся', () => {
  process.env.SECRETS_KEY = 'KEY-B';
  process.env.SECRETS_KEYS_OLD = 'KEY-A';
  // значение зашифровано A, но B+old=A → дешифровка проходит
  assert.equal(getTenantSecret('rot', 'tg_bot_token'), 'botA');
  // lookup записан под A, но кандидаты включают индекс по A → резолв работает
  assert.equal(resolveTenantByWebhookSecret('whA').id, 'rot');
});

test('reencrypt: перешифровка под B, индексы пересчитаны', () => {
  const r = reencryptSecrets();
  assert.equal(r.ok, true);
  assert.ok(r.reencrypted >= 2);
  // убираем старый ключ — теперь всё должно работать только на B
  process.env.SECRETS_KEYS_OLD = '';
  assert.equal(getTenantSecret('rot', 'tg_bot_token'), 'botA');
  assert.equal(resolveTenantByWebhookSecret('whA').id, 'rot');
});

test('после ротации старый ключ больше не нужен; чужой ключ → ошибка', () => {
  // только неверный ключ, без old → дешифровка падает
  process.env.SECRETS_KEY = 'KEY-WRONG';
  process.env.SECRETS_KEYS_OLD = '';
  assert.throws(() => getTenantSecret('rot', 'tg_bot_token'), /не подошёл/);
  // возвращаем актуальный ключ
  process.env.SECRETS_KEY = 'KEY-B';
});

let server, base;
before(async () => {
  const app = createApp();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

test('admin: POST /api/admin/secrets/rotate', async () => {
  const r = await fetch(`${base}/api/admin/secrets/rotate`, { method: 'POST', headers: { 'X-Api-Key': 'admin-key' } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.ok(body.reencrypted >= 2);

  // под пользовательским ключом — нельзя
  const denied = await fetch(`${base}/api/admin/secrets/rotate`, { method: 'POST', headers: { 'X-Api-Key': 'wrong' } });
  assert.equal(denied.status, 401);
});
