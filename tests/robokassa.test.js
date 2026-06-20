/**
 * Тесты приёма оплаты (Robokassa) + ядра счетов (payments).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

const TMP = fs.mkdtempSync('/tmp/secretary-test-robo-');
process.env.STATE_DIR = TMP;
process.env.PERSONA_DIR = './persona';
process.env.OWNER_CHAT_ID = '1';
process.env.ONEINT_BOT_TOKEN = 'dummy';
process.env.API_KEY = 'user-key';
process.env.ADMIN_API_KEY = 'admin-key';
process.env.ROBOKASSA_MERCHANT_LOGIN = 'shop';
process.env.ROBOKASSA_PASSWORD1 = 'pw1';
process.env.ROBOKASSA_PASSWORD2 = 'pw2';
process.env.PRICE_PRO = '990';

const { seedDefaultTenant, createTenant, getTenant, setTenantStatus } = await import('../src/core/tenant.js');
const { createInvoice, getInvoice, markInvoicePaid, purchasablePlans } = await import('../src/core/payments.js');
const robokassa = await import('../src/connectors/robokassa.js');
const { createApp } = await import('../src/app.js');

seedDefaultTenant();
const md5 = s => crypto.createHash('md5').update(s, 'utf8').digest('hex');

test('payments: createInvoice (pending), цена из тарифа, free не покупается', () => {
  createTenant({ id: 'buyer', plan: 'free' });
  assert.deepEqual(purchasablePlans().sort(), ['enterprise', 'pro']);
  const r = createInvoice('buyer', 'pro');
  assert.equal(r.ok, true);
  assert.equal(r.invoice.status, 'pending');
  assert.equal(r.invoice.amount, 990);            // server-side из PRICE_PRO
  assert.equal(createInvoice('buyer', 'free').ok, false);
});

test('payments: markInvoicePaid применяет тариф, активирует, идемпотентно', () => {
  createTenant({ id: 'b2', plan: 'free' });
  setTenantStatus('b2', 'suspended');
  const inv = createInvoice('b2', 'pro').invoice;
  const r = markInvoicePaid(inv.inv_id);
  assert.equal(r.ok, true);
  assert.equal(getTenant('b2').plan, 'pro');
  assert.equal(getTenant('b2').status, 'active'); // оплата снимает suspend
  // повтор не ломает (вебхуки Robokassa повторяются)
  const again = markInvoicePaid(inv.inv_id);
  assert.equal(again.already, true);
});

test('robokassa: подпись ссылки оплаты и проверка Result', () => {
  assert.equal(robokassa.isConfigured(), true);
  const inv = createInvoice('buyer', 'pro').invoice;
  const pay = robokassa.buildPaymentUrl(inv);
  assert.equal(pay.ok, true);
  const expectSig = md5(`shop:990:${inv.inv_id}:pw1`);
  assert.ok(pay.url.includes(`SignatureValue=${expectSig}`));
  assert.ok(pay.url.includes(`InvId=${inv.inv_id}`));

  // Result-подпись (Password2)
  const sig = md5(`990:${inv.inv_id}:pw2`);
  assert.equal(robokassa.verifyResult({ OutSum: '990', InvId: String(inv.inv_id), SignatureValue: sig }), true);
  assert.equal(robokassa.verifyResult({ OutSum: '990', InvId: String(inv.inv_id), SignatureValue: 'deadbeef' }), false);
  assert.equal(robokassa.resultAck(inv.inv_id), `OK${inv.inv_id}`);
});

// --- HTTP ---
let server, base;
before(async () => {
  const app = createApp();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

test('admin: checkout создаёт счёт и ссылку оплаты', async () => {
  createTenant({ id: 'web', plan: 'free' });
  const r = await fetch(`${base}/api/admin/tenants/web/billing/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'admin-key' },
    body: JSON.stringify({ plan: 'pro' })
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.invoice.plan, 'pro');
  assert.ok(body.payment_url.startsWith('https://auth.robokassa.ru/'));
});

test('webhook Result: валидная подпись → OK<InvId> + апгрейд тарифа', async () => {
  const inv = createInvoice('web', 'pro').invoice;
  const sig = md5(`990:${inv.inv_id}:pw2`);
  const r = await fetch(`${base}/robokassa/result?OutSum=990&InvId=${inv.inv_id}&SignatureValue=${sig}`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), `OK${inv.inv_id}`);
  assert.equal(getTenant('web').plan, 'pro');
  assert.equal(getInvoice(inv.inv_id).status, 'paid');

  // невалидная подпись → 400, тариф не меняется
  createTenant({ id: 'web2', plan: 'free' });
  const inv2 = createInvoice('web2', 'pro').invoice;
  const bad = await fetch(`${base}/robokassa/result?OutSum=990&InvId=${inv2.inv_id}&SignatureValue=bad`);
  assert.equal(bad.status, 400);
  assert.equal(getTenant('web2').plan, 'free');
});

test('webhook Result доступен без API-ключа (авторизация подписью)', async () => {
  // /robokassa/* не под /api/* — ключ не требуется; проверяем что не 401
  const r = await fetch(`${base}/robokassa/result?OutSum=1&InvId=999999&SignatureValue=x`);
  assert.notEqual(r.status, 401);
});
