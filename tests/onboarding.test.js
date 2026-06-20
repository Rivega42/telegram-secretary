/**
 * Тесты онбординга (SaaS, фаза S5): подключение бота, setWebhook,
 * резолв арендатора по секрету вебхука, мастер готовности, admin API.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TMP = fs.mkdtempSync('/tmp/secretary-test-onboarding-');
process.env.STATE_DIR = TMP;
process.env.PERSONA_DIR = './persona';
process.env.DRY_RUN = 'true';
process.env.DRY_RUN_BRAIN = 'true';
process.env.OWNER_CHAT_ID = '1';
process.env.ONEINT_BOT_TOKEN = 'dummy';
process.env.API_KEY = 'user-key';
process.env.ADMIN_API_KEY = 'admin-key';
process.env.WEBHOOK_SECRET = 'global-secret';   // одно-владельческий секрет
process.env.PUBLIC_BASE_URL = 'https://example.test/';

const { seedDefaultTenant, createTenant, getTenant, getTenantSecret, listChannels,
        resolveTenantByWebhookSecret } = await import('../src/core/tenant.js');
const { connectTelegram, checkReadiness, onboard } = await import('../src/core/onboarding.js');
const { createApp } = await import('../src/app.js');

seedDefaultTenant();

test('connectTelegram: привязывает канал, секреты и (DRY_RUN) вебхук', async () => {
  createTenant({ id: 'acme', plan: 'pro' });
  const r = await connectTelegram('acme', { botToken: 'token-acme' });
  assert.equal(r.ok, true);
  assert.ok(r.bot.id > 0);
  assert.equal(r.channel_key, `tg:${r.bot.id}`);
  assert.equal(r.webhook_set, true);          // PUBLIC_BASE_URL задан → setWebhook (DRY_RUN ok)
  // канал и секреты на месте
  assert.ok(listChannels('acme').includes(r.channel_key));
  assert.ok(getTenantSecret('acme', 'tg_bot_token'));
  assert.ok(getTenantSecret('acme', 'tg_webhook_secret'));
});

test('resolveTenantByWebhookSecret: апдейт резолвится в арендатора', () => {
  const secret = getTenantSecret('acme', 'tg_webhook_secret');
  assert.equal(resolveTenantByWebhookSecret(secret).id, 'acme');
  assert.equal(resolveTenantByWebhookSecret('нет-такого'), null);
});

test('connectTelegram: чужой бот нельзя перехватить', async () => {
  createTenant({ id: 'rival', plan: 'free' });
  // тот же токен → тот же bot_id → канал занят acme
  const r = await connectTelegram('rival', { botToken: 'token-acme' });
  assert.equal(r.ok, false);
  assert.match(r.error, /уже привязан/);
});

test('checkReadiness: fail без каналов, ok после подключения', async () => {
  createTenant({ id: 'fresh', plan: 'free' });
  const before = checkReadiness('fresh');
  assert.equal(before.ready, false);
  assert.equal(before.checks.find(c => c.id === 'channels').status, 'fail');

  await connectTelegram('fresh', { botToken: 'token-fresh' });
  const after = checkReadiness('fresh');
  assert.equal(after.ready, true);
  assert.equal(after.checks.find(c => c.id === 'channels').status, 'ok');
  assert.equal(after.checks.find(c => c.id === 'bot').status, 'ok');
});

test('onboard: сквозной поток (арендатор + персона + бот + готовность)', async () => {
  const r = await onboard({
    id: 'studio', name: 'Studio', owner_chat_id: '777', plan: 'pro',
    persona: { persona_json: { secretary_name: 'Алиса' } },
    bot_token: 'token-studio'
  });
  assert.equal(r.ok, true);
  assert.equal(r.persona, true);
  assert.equal(r.telegram.ok, true);
  assert.equal(r.readiness.ready, true);
  assert.equal(getTenant('studio').owner_chat_id, '777');
});

// --- admin API + маршрутизация вебхука ---
let server, base;
before(async () => {
  const app = createApp();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

test('admin: POST /api/admin/onboard создаёт арендатора', async () => {
  const r = await fetch(`${base}/api/admin/onboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'admin-key' },
    body: JSON.stringify({ id: 'viaapi', plan: 'free', bot_token: 'token-viaapi' })
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.telegram.ok, true);
  assert.ok(body.readiness);
  // пользовательский ключ не пускает в admin
  const denied = await fetch(`${base}/api/admin/onboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'user-key' },
    body: JSON.stringify({ id: 'x' })
  });
  assert.equal(denied.status, 401);
});

test('admin: GET /readiness отдаёт чеклист', async () => {
  const r = await fetch(`${base}/api/admin/tenants/acme/readiness`, { headers: { 'X-Api-Key': 'admin-key' } });
  const body = await r.json();
  assert.equal(body.tenant_id, 'acme');
  assert.ok(Array.isArray(body.checks));
});

test('webhook: per-tenant секрет авторизует апдейт мимо глобального WEBHOOK_SECRET', async () => {
  const secret = getTenantSecret('acme', 'tg_webhook_secret');
  // заголовок не совпадает с WEBHOOK_SECRET, но это валидный tenant-секрет → 200
  const r = await fetch(`${base}/tg/business-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify({ update_id: 9001, business_connection: { id: 'bc1', is_enabled: true } })
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.type, 'business_connection');
});

test('webhook: неверный секрет без tenant-совпадения → 403', async () => {
  const r = await fetch(`${base}/tg/business-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret-no-match' },
    body: JSON.stringify({ update_id: 9002, business_connection: { id: 'bc2', is_enabled: true } })
  });
  assert.equal(r.status, 403);
});
