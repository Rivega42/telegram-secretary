/**
 * Тесты BYO-LLM арендатора (Enterprise): конфиг, гейт тарифа, шифрование
 * ключа, переопределение инстанса в core/brain.js, admin API.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TMP = fs.mkdtempSync('/tmp/secretary-test-tllm-');
process.env.STATE_DIR = TMP;
process.env.PERSONA_DIR = './persona';
process.env.OWNER_CHAT_ID = '1';
process.env.ONEINT_BOT_TOKEN = 'dummy';
process.env.API_KEY = 'user-key';
process.env.ADMIN_API_KEY = 'admin-key';
process.env.SECRETS_KEY = 'tllm-master-key';
// DRY_RUN_BRAIN НЕ включаем — нужен путь резолва инстанса в brain.respond

const { runWithTenant } = await import('../src/core/context.js');
const { seedDefaultTenant, createTenant, getTenantSecret } = await import('../src/core/tenant.js');
const { setTenantLlm, clearTenantLlm, getTenantLlmPublic, getTenantInstance } = await import('../src/core/tenant-llm.js');
const { getDb } = await import('../src/core/db.js');
const { createApp } = await import('../src/app.js');

seedDefaultTenant();                                   // enterprise
createTenant({ id: 'ent', plan: 'enterprise' });
createTenant({ id: 'freebie', plan: 'free' });

test('гейт тарифа: free не может подключить свой LLM', () => {
  const r = setTenantLlm('freebie', { base_url: 'http://llm.local', model: 'm' });
  assert.equal(r.ok, false);
  assert.match(r.error, /enterprise/);
});

test('enterprise: подключение, ключ шифруется, наружу не отдаётся', () => {
  const r = setTenantLlm('ent', { driver: 'stateless-llm', base_url: 'http://llm.local/v1/', model: 'gpt-x', api_key: 'sk-tenant-123' });
  assert.equal(r.ok, true);
  assert.equal(r.llm.base_url, 'http://llm.local/v1'); // хвостовой слеш убран
  assert.equal(r.llm.api_key_set, true);
  assert.equal(r.llm.api_key, undefined);              // ключ не в ответе

  // public-вывод без ключа
  const pub = getTenantLlmPublic('ent');
  assert.equal(pub.model, 'gpt-x');
  assert.ok(!('api_key' in pub) || pub.api_key === undefined);

  // в БД ключ зашифрован
  const raw = getDb().prepare("SELECT value FROM tenant_secrets WHERE tenant_id='ent' AND key='llm_api_key'").get();
  assert.match(raw.value, /^v1\./);
  assert.ok(!raw.value.includes('sk-tenant-123'));
  // через getTenantSecret — расшифровано
  assert.equal(getTenantSecret('ent', 'llm_api_key'), 'sk-tenant-123');
});

test('getTenantInstance: резолвится для арендатора, null без конфига', () => {
  const inst = getTenantInstance('ent');
  assert.equal(inst.base_url, 'http://llm.local/v1');
  assert.equal(inst.api_key, 'sk-tenant-123');         // расшифрован для драйвера
  assert.equal(inst.driver, 'stateless-llm');
  assert.equal(getTenantInstance('freebie'), null);
});

test('brain.respond бьёт по endpoint арендатора с его ключом', async () => {
  const http = await import('node:http');
  const { respond } = await import('../src/core/brain.js');
  const { createEnvelope } = await import('../src/core/envelope.js');
  const { loadPersona } = await import('../src/core/persona.js');

  // Локальный стаб OpenAI-совместимого LLM: фиксирует путь и Authorization
  let hit = null;
  const stub = http.createServer((req, res) => {
    hit = { url: req.url, auth: req.headers.authorization };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'stub', choices: [{ message: { content: 'BYO-OK' } }], usage: { total_tokens: 7 } }));
  });
  await new Promise(r => stub.listen(0, r));
  const port = stub.address().port;

  setTenantLlm('ent', { driver: 'stateless-llm', base_url: `http://127.0.0.1:${port}`, model: 'stub-model', api_key: 'sk-byo' });

  const env = createEnvelope({
    platform: 'telegram', surface: 'dm',
    identity: { platform_user_id: 5, display_name: 'Y' },
    threadKey: 'telegram:dm:5', text: 'привет'
  });
  const res = await runWithTenant('ent', () => respond(env, { persona: runWithTenant('ent', () => loadPersona()) }));
  stub.close();

  assert.equal(res.ok, true);
  assert.equal(res.text, 'BYO-OK');                       // ответ пришёл от tenant-endpoint
  assert.equal(hit.url, '/v1/chat/completions');          // путь драйвера
  assert.equal(hit.auth, 'Bearer sk-byo');                // ключ арендатора (расшифрован)
});

test('частичное обновление и сброс', () => {
  createTenant({ id: 'ent2', plan: 'enterprise' });
  setTenantLlm('ent2', { base_url: 'http://keep.local', model: 'm0', api_key: 'sk-0' });
  setTenantLlm('ent2', { model: 'gpt-y' });             // меняем только модель
  assert.equal(getTenantLlmPublic('ent2').model, 'gpt-y');
  assert.equal(getTenantLlmPublic('ent2').base_url, 'http://keep.local'); // сохранился
  assert.equal(getTenantLlmPublic('ent2').api_key_set, true);             // ключ сохранён
  assert.equal(clearTenantLlm('ent2').cleared, true);
  assert.equal(getTenantLlmPublic('ent2'), null);
});

// --- admin API ---
let server, base;
before(async () => {
  const app = createApp();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

test('admin: POST/GET/DELETE llm + гейт ключа', async () => {
  const post = await fetch(`${base}/api/admin/tenants/ent/llm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'admin-key' },
    body: JSON.stringify({ base_url: 'http://byo.local', model: 'm1', api_key: 'sk-abc' })
  });
  assert.equal(post.status, 200);
  assert.equal((await post.json()).llm.api_key_set, true);

  const get = await fetch(`${base}/api/admin/tenants/ent/llm`, { headers: { 'X-Api-Key': 'admin-key' } });
  const body = await get.json();
  assert.equal(body.model, 'm1');
  assert.ok(body.api_key === undefined);

  // free → 400 (гейт тарифа)
  const denied = await fetch(`${base}/api/admin/tenants/freebie/llm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'admin-key' },
    body: JSON.stringify({ base_url: 'http://x', model: 'm' })
  });
  assert.equal(denied.status, 400);

  const del = await fetch(`${base}/api/admin/tenants/ent/llm`, { method: 'DELETE', headers: { 'X-Api-Key': 'admin-key' } });
  assert.equal((await del.json()).cleared, true);
});
