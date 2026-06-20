/**
 * Тесты биллинга и лимитов (SaaS, фаза S4).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TMP = fs.mkdtempSync('/tmp/secretary-test-billing-');
process.env.STATE_DIR = TMP;
process.env.PERSONA_DIR = './persona';
process.env.DRY_RUN = 'true';
process.env.DRY_RUN_BRAIN = 'true';
process.env.OWNER_CHAT_ID = '1';
process.env.ONEINT_BOT_TOKEN = 'dummy';
process.env.API_KEY = 'user-key';
process.env.ADMIN_API_KEY = 'admin-key';

const { runWithTenant } = await import('../src/core/context.js');
const { createTenant, setTenantPlan, setTenantStatus, seedDefaultTenant } = await import('../src/core/tenant.js');
const { recordUsage, getUsage, checkQuota, usageSummary, PLANS } = await import('../src/core/billing.js');
const { respond: brainRespond } = await import('../src/core/brain.js');
const { createEnvelope } = await import('../src/core/envelope.js');
const { createApp } = await import('../src/app.js');

seedDefaultTenant();                        // enterprise — безлимит
createTenant({ id: 'free1', plan: 'free' });
createTenant({ id: 'pro1', plan: 'pro' });

function dmEnvelope(platform = 'telegram') {
  return createEnvelope({
    platform, surface: 'dm',
    identity: { platform_user_id: 1, display_name: 'X' },
    threadKey: `${platform}:dm:1`, text: 'привет'
  });
}

test('recordUsage/getUsage: счётчики per-tenant per-month', () => {
  runWithTenant('free1', () => recordUsage('replies', 3));
  runWithTenant('free1', () => recordUsage('tokens', 150));
  runWithTenant('pro1', () => recordUsage('replies', 1));
  assert.equal(getUsage('free1').replies, 3);
  assert.equal(getUsage('free1').tokens, 150);
  assert.equal(getUsage('pro1').replies, 1); // изолировано
});

test('checkQuota: безлимитный enterprise (default) и платформы тарифа', () => {
  assert.equal(runWithTenant('default', () => checkQuota('telegram')).allowed, true);
  // free не включает vk/whatsapp
  assert.equal(runWithTenant('free1', () => checkQuota('vk')).reason, 'platform_not_in_plan');
  assert.equal(runWithTenant('free1', () => checkQuota('telegram')).allowed, true);
  // pro включает все
  assert.equal(runWithTenant('pro1', () => checkQuota('whatsapp')).allowed, true);
});

test('checkQuota: превышение месячного лимита ответов', () => {
  createTenant({ id: 'lim', plan: 'free' });
  runWithTenant('lim', () => recordUsage('replies', PLANS.free.replies_per_month));
  assert.equal(runWithTenant('lim', () => checkQuota('telegram')).reason, 'quota_exceeded');
});

test('checkQuota: suspended арендатор запрещён', () => {
  setTenantStatus('pro1', 'suspended');
  assert.equal(runWithTenant('pro1', () => checkQuota('telegram')).reason, 'suspended');
  setTenantStatus('pro1', 'active');
});

test('brain.respond: при лимите возвращает limited без генерации и без расхода', async () => {
  createTenant({ id: 'overlimit', plan: 'free' });
  runWithTenant('overlimit', () => recordUsage('replies', 100));
  const before = getUsage('overlimit').replies;
  const res = await runWithTenant('overlimit', () => brainRespond(dmEnvelope(), {}));
  assert.equal(res.ok, false);
  assert.equal(res.limited, true);
  assert.equal(res.text, '');
  // расход не вырос (генерации не было)
  assert.equal(getUsage('overlimit').replies, before);
});

test('brain.respond: в пределах лимита учитывает ответ (replies++)', async () => {
  const before = getUsage('free1').replies;
  const res = await runWithTenant('free1', () => brainRespond(dmEnvelope(), {}));
  assert.equal(res.ok, true);
  assert.equal(getUsage('free1').replies, before + 1);
});

test('brain.respond: платформа вне тарифа → limited', async () => {
  const res = await runWithTenant('free1', () => brainRespond(dmEnvelope('vk'), {}));
  assert.equal(res.limited, true);
  assert.equal(res.reason, 'platform_not_in_plan');
});

// --- admin API ---
let server, base;
before(async () => {
  const app = createApp();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

test('admin: usage и смена тарифа через API', async () => {
  const r = await fetch(`${base}/api/admin/tenants/free1/usage`, { headers: { 'X-Api-Key': 'admin-key' } });
  const body = await r.json();
  assert.equal(body.plan, 'free');
  assert.equal(body.replies_limit, PLANS.free.replies_per_month);
  assert.ok(body.replies >= 1);

  const plan = await fetch(`${base}/api/admin/tenants/free1/plan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'admin-key' },
    body: JSON.stringify({ plan: 'pro' })
  });
  assert.equal((await plan.json()).tenant.plan, 'pro');

  // usage недоступен пользовательским ключом
  assert.equal((await fetch(`${base}/api/admin/tenants/free1/usage`, { headers: { 'X-Api-Key': 'user-key' } })).status, 401);
});

test('usageSummary: структура', () => {
  const s = usageSummary('pro1');
  assert.equal(s.plan, 'pro');
  assert.ok('replies' in s && 'tokens' in s && 'replies_limit' in s);
});
