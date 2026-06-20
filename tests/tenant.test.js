/**
 * Тесты реестра арендаторов (SaaS, фаза S1).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TMP = fs.mkdtempSync('/tmp/secretary-test-tenant-');
process.env.STATE_DIR = TMP;
process.env.PERSONA_DIR = './persona';
process.env.DRY_RUN = 'true';
process.env.DRY_RUN_BRAIN = 'true';
process.env.OWNER_CHAT_ID = '1';
process.env.ONEINT_BOT_TOKEN = 'dummy';
process.env.API_KEY = 'user-key';
process.env.ADMIN_API_KEY = 'admin-key';

const {
  createTenant, getTenant, listTenants, setTenantStatus, setTenantPlan,
  registerChannel, resolveTenant, seedDefaultTenant, DEFAULT_TENANT
} = await import('../src/core/tenant.js');
const { createApp } = await import('../src/app.js');

test('createTenant: валидация id, дубликат отклоняется', () => {
  assert.equal(createTenant({ id: '' }).ok, false);
  assert.equal(createTenant({ id: 'bad id!' }).ok, false);
  const a = createTenant({ id: 'acme', name: 'ACME', ownerChatId: '555', plan: 'pro' });
  assert.equal(a.ok, true);
  assert.equal(a.tenant.status, 'active');
  assert.equal(a.tenant.plan, 'pro');
  assert.equal(createTenant({ id: 'acme' }).ok, false); // дубликат
});

test('каналы и резолв: ключ канала → арендатор; неизвестный → null', () => {
  registerChannel('wa:12345', 'acme');
  registerChannel('vk:999', 'acme');
  assert.equal(resolveTenant('wa:12345').id, 'acme');
  assert.equal(resolveTenant('vk:999').id, 'acme');
  assert.equal(resolveTenant('tg:unknown'), null);
});

test('статус и тариф: смена и валидация', () => {
  assert.equal(setTenantStatus('acme', 'suspended').ok, true);
  assert.equal(getTenant('acme').status, 'suspended');
  assert.equal(setTenantStatus('acme', 'nonsense').ok, false);
  assert.equal(setTenantPlan('acme', 'enterprise').ok, true);
  assert.equal(setTenantStatus('missing', 'active').ok, false);
});

test('seedDefaultTenant: идемпотентно, default из env', () => {
  seedDefaultTenant();
  seedDefaultTenant(); // второй раз не дублирует
  const def = getTenant(DEFAULT_TENANT);
  assert.ok(def);
  assert.equal(def.owner_chat_id, '1');
  assert.equal(listTenants().filter(t => t.id === DEFAULT_TENANT).length, 1);
});

// --- админ-API ---
let server, base;
before(async () => {
  const app = createApp();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

async function adminReq(path, opts = {}) {
  const r = await fetch(`${base}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'admin-key', ...(opts.headers || {}) }
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

test('admin-API: пользовательский ключ не открывает /api/admin', async () => {
  const r = await fetch(`${base}/api/admin/tenants`, { headers: { 'X-Api-Key': 'user-key' } });
  assert.equal(r.status, 401);
});

test('admin-API: список, создание, статус арендатора', async () => {
  const list = await adminReq('/api/admin/tenants');
  assert.equal(list.status, 200);
  assert.ok(list.body.count >= 1);

  const created = await adminReq('/api/admin/tenants', {
    method: 'POST', body: JSON.stringify({ id: 'beta', name: 'Beta', owner_chat_id: '777' })
  });
  assert.equal(created.status, 201);

  const reg = await adminReq('/api/admin/tenants/beta/channels', {
    method: 'POST', body: JSON.stringify({ channel_key: 'tg:42' })
  });
  assert.equal(reg.status, 201);

  const got = await adminReq('/api/admin/tenants/beta');
  assert.ok(got.body.channels.includes('tg:42'));

  const susp = await adminReq('/api/admin/tenants/beta/status', {
    method: 'POST', body: JSON.stringify({ status: 'suspended' })
  });
  assert.equal(susp.body.tenant.status, 'suspended');
});
