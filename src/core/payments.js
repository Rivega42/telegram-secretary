/**
 * payments.js — провайдеро-независимое ядро биллинга-приёма-оплаты (SaaS)
 *
 * Счёт (invoice) на смену тарифа: создаётся в pending, провайдер (Robokassa и др.)
 * подтверждает оплату → invoice paid → применяется тариф (setTenantPlan + active).
 * Провайдеро-специфика (подпись, URL) живёт в connectors/<provider>.js.
 *
 * Цены — в рублях/мес, целые. Сервер берёт сумму ИЗ тарифа (не доверяет клиенту).
 */

import { getDb } from './db.js';
import { getTenant, setTenantPlan, setTenantStatus } from './tenant.js';
import { PLANS } from './billing.js';

// Стоимость платных тарифов, ₽/мес. Переопределяется env PRICE_PRO / PRICE_ENTERPRISE.
export const PLAN_PRICES = {
  pro: parseInt(process.env.PRICE_PRO || '990', 10),
  enterprise: parseInt(process.env.PRICE_ENTERPRISE || '4990', 10)
};

/** Платные тарифы, доступные к покупке (free выдаётся бесплатно). */
export function purchasablePlans() {
  return Object.keys(PLAN_PRICES).filter(p => PLANS[p]);
}

/**
 * Создать счёт на смену тарифа. amount берётся из PLAN_PRICES (server-side).
 */
export function createInvoice(tenantId, plan, { provider = 'robokassa' } = {}) {
  if (!getTenant(tenantId)) return { ok: false, error: 'tenant not found' };
  if (!purchasablePlans().includes(plan)) {
    return { ok: false, error: `план не для покупки: ${purchasablePlans().join(' | ')}` };
  }
  const amount = PLAN_PRICES[plan];
  const info = getDb().prepare(
    `INSERT INTO invoices (tenant_id, plan, amount, currency, status, provider, created_at)
     VALUES (?, ?, ?, 'RUB', 'pending', ?, ?)`
  ).run(tenantId, plan, amount, provider, new Date().toISOString());
  return { ok: true, invoice: getInvoice(info.lastInsertRowid) };
}

export function getInvoice(invId) {
  return getDb().prepare('SELECT * FROM invoices WHERE inv_id = ?').get(Number(invId)) || null;
}

export function listInvoices(tenantId) {
  return getDb().prepare('SELECT * FROM invoices WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId);
}

/**
 * Пометить счёт оплаченным и применить тариф. Идемпотентно: повторный вызов
 * для уже оплаченного счёта ничего не меняет (вебхуки провайдера повторяются).
 */
export function markInvoicePaid(invId) {
  const inv = getInvoice(invId);
  if (!inv) return { ok: false, error: 'invoice not found' };
  if (inv.status === 'paid') return { ok: true, invoice: inv, already: true };

  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("UPDATE invoices SET status = 'paid', paid_at = ? WHERE inv_id = ?")
      .run(new Date().toISOString(), inv.inv_id);
    setTenantPlan(inv.tenant_id, inv.plan);
    setTenantStatus(inv.tenant_id, 'active'); // оплата снимает возможный suspend
  });
  tx();
  return { ok: true, invoice: getInvoice(invId) };
}

export function markInvoiceFailed(invId) {
  const inv = getInvoice(invId);
  if (!inv) return { ok: false, error: 'invoice not found' };
  if (inv.status === 'paid') return { ok: false, error: 'already paid' };
  getDb().prepare("UPDATE invoices SET status = 'failed' WHERE inv_id = ?").run(inv.inv_id);
  return { ok: true, invoice: getInvoice(invId) };
}
