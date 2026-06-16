/**
 * billing.js — учёт расхода и лимиты по тарифам (SaaS, фаза S4)
 *
 * Метрики per-tenant per-month в таблице usage:
 *   replies — сгенерированные ответы (≈ единица стоимости/ценности)
 *   tokens  — токены LLM (если endpoint вернул usage)
 *
 * Квота проверяется в core/brain.js ДО генерации (экономит LLM при превышении):
 *   suspended → запрет; платформа вне тарифа → запрет; превышен лимит ответов → запрет.
 *
 * Арендатор `default` сидится как enterprise (без лимита) — single-owner не лимитируется.
 * Арендатор без записи в реестре (тесты) — не лимитируется.
 */

import { getDb } from './db.js';
import { currentTenantId } from './context.js';
import { getTenant } from './tenant.js';

export const PLANS = {
  free:       { replies_per_month: 100,  platforms: ['telegram'] },
  pro:        { replies_per_month: 5000, platforms: ['telegram', 'vk', 'whatsapp'] },
  enterprise: { replies_per_month: null, platforms: ['telegram', 'vk', 'whatsapp'] } // null = безлимит
};

export function currentPeriod(d = new Date()) {
  return d.toISOString().slice(0, 7); // YYYY-MM
}

export function planOf(tenant) {
  return PLANS[tenant?.plan] || PLANS.free;
}

/**
 * Увеличить счётчик метрики текущего арендатора за текущий месяц.
 */
export function recordUsage(metric, n = 1, period = currentPeriod()) {
  if (!n) return;
  getDb().prepare(
    `INSERT INTO usage (tenant_id, period, metric, count) VALUES (?, ?, ?, ?)
     ON CONFLICT(tenant_id, period, metric) DO UPDATE SET count = count + excluded.count`
  ).run(currentTenantId(), period, metric, n);
}

export function getUsage(tenantId, period = currentPeriod()) {
  const rows = getDb().prepare('SELECT metric, count FROM usage WHERE tenant_id = ? AND period = ?').all(tenantId, period);
  const out = {};
  for (const r of rows) out[r.metric] = r.count;
  return out;
}

/**
 * Можно ли арендатору сейчас автоотвечать.
 * platform — если задана, проверяется доступность платформы в тарифе.
 */
export function checkQuota(platform = null) {
  const tenant = getTenant(currentTenantId());
  if (!tenant) return { allowed: true }; // нет записи (single-owner/тесты)
  if (tenant.status === 'suspended') return { allowed: false, reason: 'suspended' };
  const plan = planOf(tenant);
  if (platform && plan.platforms && !plan.platforms.includes(platform)) {
    return { allowed: false, reason: 'platform_not_in_plan' };
  }
  if (plan.replies_per_month != null) {
    const used = getUsage(tenant.id).replies || 0;
    if (used >= plan.replies_per_month) return { allowed: false, reason: 'quota_exceeded' };
  }
  return { allowed: true };
}

/**
 * Сводка расхода для admin/дайджеста.
 */
export function usageSummary(tenantId = currentTenantId(), period = currentPeriod()) {
  const tenant = getTenant(tenantId);
  const plan = planOf(tenant);
  const used = getUsage(tenantId, period);
  return {
    tenant_id: tenantId,
    period,
    plan: tenant?.plan || null,
    status: tenant?.status || null,
    replies: used.replies || 0,
    tokens: used.tokens || 0,
    replies_limit: plan.replies_per_month,
    platforms: plan.platforms
  };
}

// Троттлинг алертов владельцу о лимите: не чаще раза в час на арендатора
const lastAlert = new Map();
export function shouldAlertLimit(tenantId = currentTenantId(), windowMs = 3600000) {
  const now = Date.now();
  if (now - (lastAlert.get(tenantId) || 0) < windowMs) return false;
  lastAlert.set(tenantId, now);
  return true;
}
