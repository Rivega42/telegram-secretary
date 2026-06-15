/**
 * Тесты конфига per-tenant (SaaS, фаза S3): персона, режимы, владелец.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TMP = fs.mkdtempSync('/tmp/secretary-test-s3-');
process.env.STATE_DIR = TMP;
process.env.PERSONA_DIR = './persona';
process.env.DRY_RUN = 'true';
process.env.OWNER_CHAT_ID = '1';
process.env.API_KEY = 'user-key';
process.env.ADMIN_API_KEY = 'admin-key';
process.env.ONEINT_BOT_TOKEN = 'dummy';

const { runWithTenant } = await import('../src/core/context.js');
const { createTenant, seedDefaultTenant } = await import('../src/core/tenant.js');
const { loadPersona, buildSystemPrompt, setTenantPersona } = await import('../src/core/persona.js');
const { getSettings, setMode, setDraft } = await import('../src/core/modes.js');
const { createApp } = await import('../src/app.js');

seedDefaultTenant();
createTenant({ id: 'acme', name: 'ACME', ownerChatId: '555' });

test('персона: default из файлов, новый арендатор — нейтральная generic', () => {
  const def = runWithTenant('default', () => loadPersona({ force: true }));
  assert.equal(def.secretary_name, 'Вика'); // из persona/persona.json

  const acme = runWithTenant('acme', () => loadPersona({ force: true }));
  assert.equal(acme.secretary_name, 'Ассистент'); // нейтральная, без имён
  assert.ok(!buildSystemPrompt(acme, 'dm').includes('Вика'));
});

test('персона арендатора: задаётся и подхватывается, не трогая default', () => {
  setTenantPersona('acme', {
    persona_json: { secretary_name: 'Макс', owner: { name: 'Пётр' }, disclosure: { dm: true } },
    base_md: 'Ты — {{secretary_name}}, секретарь {{owner_name}}.',
    facts_md: 'Цена курса 5000р.'
  });
  const acme = runWithTenant('acme', () => loadPersona({ force: true }));
  assert.equal(acme.secretary_name, 'Макс');
  const prompt = buildSystemPrompt(acme, 'dm');
  assert.ok(prompt.includes('Макс'));
  assert.ok(prompt.includes('Пётр'));
  assert.ok(prompt.includes('Цена курса 5000р'));

  // default не изменился
  const def = runWithTenant('default', () => loadPersona({ force: true }));
  assert.equal(def.secretary_name, 'Вика');
});

test('режимы per-tenant: независимы у арендаторов', () => {
  runWithTenant('default', () => setMode('off'));
  runWithTenant('acme', () => setMode('vacation'));
  assert.equal(runWithTenant('default', () => getSettings()).mode, 'off');
  assert.equal(runWithTenant('acme', () => getSettings()).mode, 'vacation');

  runWithTenant('acme', () => setDraft(true));
  assert.equal(runWithTenant('acme', () => getSettings()).draft, true);
  assert.equal(runWithTenant('default', () => getSettings()).draft, false);
  runWithTenant('default', () => setMode('auto'));
});

// --- admin API ---
let server, base;
before(async () => {
  const app = createApp();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

async function admin(path, opts = {}) {
  const r = await fetch(`${base}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'admin-key', ...(opts.headers || {}) }
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

test('admin: персона арендатора через API', async () => {
  const set = await admin('/api/admin/tenants/acme/persona', {
    method: 'POST',
    body: JSON.stringify({ persona_json: { secretary_name: 'Лена' }, base_md: 'Я {{secretary_name}}.' })
  });
  assert.equal(set.status, 200);
  const got = await admin('/api/admin/tenants/acme/persona');
  assert.ok(got.body.persona_json.includes('Лена'));
  // несуществующий арендатор → 404
  assert.equal((await admin('/api/admin/tenants/nope/persona')).status, 404);
});

test('admin: настройки режима арендатора через API', async () => {
  const set = await admin('/api/admin/tenants/acme/settings', {
    method: 'POST', body: JSON.stringify({ mode: 'off', draft: true })
  });
  assert.equal(set.body.settings.mode, 'off');
  assert.equal(set.body.settings.draft, true);
  // невалидный режим → 400
  assert.equal((await admin('/api/admin/tenants/acme/settings', {
    method: 'POST', body: JSON.stringify({ mode: 'bad' })
  })).status, 400);
});
