/**
 * tenant.js — реестр арендаторов (SaaS, фаза S1)
 *
 * Аддитивный слой: текущий одно-владельческий деплой = арендатор `default`
 * (сидится из env при старте). Каждый арендатор регистрирует свои каналы
 * (бот/группа/номер), по ключу канала входящее событие резолвится в арендатора.
 *
 * Изоляция данных (tenant_id во всех таблицах) — следующая фаза S2; здесь —
 * только реестр и резолв, чтобы установить шов без поломки текущего режима.
 *
 * См. docs/saas-architecture.md.
 */

import { getDb } from './db.js';

export const DEFAULT_TENANT = 'default';
export const TENANT_STATUSES = ['active', 'suspended'];

function rowToTenant(row) {
  if (!row) return null;
  return { ...row, data: safeParse(row.data) };
}

function safeParse(s) {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

export function createTenant({ id, name = '', ownerChatId = '', plan = 'free', data = {} }) {
  if (!id || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(id)) {
    return { ok: false, error: 'id обязателен: [a-z0-9_-], 2–64 символа' };
  }
  const db = getDb();
  if (db.prepare('SELECT 1 FROM tenants WHERE id = ?').get(id)) {
    return { ok: false, error: `tenant "${id}" уже существует` };
  }
  db.prepare(
    `INSERT INTO tenants (id, name, owner_chat_id, plan, status, data, created_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`
  ).run(id, name, String(ownerChatId || ''), plan, JSON.stringify(data), new Date().toISOString());
  return { ok: true, tenant: getTenant(id) };
}

export function getTenant(id) {
  return rowToTenant(getDb().prepare('SELECT * FROM tenants WHERE id = ?').get(id));
}

export function listTenants() {
  return getDb().prepare('SELECT * FROM tenants ORDER BY created_at').all().map(rowToTenant);
}

export function setTenantStatus(id, status) {
  if (!TENANT_STATUSES.includes(status)) {
    return { ok: false, error: `status: ${TENANT_STATUSES.join(' | ')}` };
  }
  const info = getDb().prepare('UPDATE tenants SET status = ? WHERE id = ?').run(status, id);
  if (!info.changes) return { ok: false, error: 'tenant not found' };
  return { ok: true, tenant: getTenant(id) };
}

export function setTenantPlan(id, plan) {
  const info = getDb().prepare('UPDATE tenants SET plan = ? WHERE id = ?').run(plan, id);
  if (!info.changes) return { ok: false, error: 'tenant not found' };
  return { ok: true, tenant: getTenant(id) };
}

/**
 * Привязать канал (бот/группа/номер) к арендатору.
 */
export function registerChannel(channelKey, tenantId) {
  if (!getTenant(tenantId)) return { ok: false, error: 'tenant not found' };
  getDb().prepare(
    'INSERT OR REPLACE INTO tenant_channels (channel_key, tenant_id) VALUES (?, ?)'
  ).run(channelKey, tenantId);
  return { ok: true };
}

export function listChannels(tenantId) {
  return getDb().prepare('SELECT channel_key FROM tenant_channels WHERE tenant_id = ?')
    .all(tenantId).map(r => r.channel_key);
}

/**
 * Резолв арендатора по ключу канала. null — неизвестный канал.
 */
export function resolveTenant(channelKey) {
  const row = getDb().prepare('SELECT tenant_id FROM tenant_channels WHERE channel_key = ?').get(channelKey);
  return row ? getTenant(row.tenant_id) : null;
}

/**
 * Секреты арендатора (SaaS S5): bot-токены, секрет вебхука. Хранятся в БД
 * (вне env — у каждого арендатора свои), наружу через API не отдаются.
 */
export function setTenantSecret(tenantId, key, value) {
  getDb().prepare(
    'INSERT OR REPLACE INTO tenant_secrets (tenant_id, key, value) VALUES (?, ?, ?)'
  ).run(tenantId, key, String(value));
  return { ok: true };
}

export function getTenantSecret(tenantId, key) {
  const row = getDb().prepare('SELECT value FROM tenant_secrets WHERE tenant_id = ? AND key = ?').get(tenantId, key);
  return row ? row.value : null;
}

/** Какие секреты заданы (только имена ключей, без значений). */
export function listTenantSecretKeys(tenantId) {
  return getDb().prepare('SELECT key FROM tenant_secrets WHERE tenant_id = ?').all(tenantId).map(r => r.key);
}

/**
 * Резолв арендатора по секрету вебхука Telegram (S5): входящий апдейт несёт
 * X-Telegram-Bot-Api-Secret-Token, по нему определяем арендатора. null — нет совпадения.
 */
export function resolveTenantByWebhookSecret(secret) {
  if (!secret) return null;
  const row = getDb().prepare(
    "SELECT tenant_id FROM tenant_secrets WHERE key = 'tg_webhook_secret' AND value = ?"
  ).get(secret);
  return row ? getTenant(row.tenant_id) : null;
}

/**
 * Сидинг арендатора `default` из env (идемпотентно). Текущий одно-владельческий
 * деплой продолжает работать как этот арендатор.
 */
export function seedDefaultTenant() {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM tenants WHERE id = ?').get(DEFAULT_TENANT)) {
    createTenant({
      id: DEFAULT_TENANT,
      name: 'Default (single-owner)',
      ownerChatId: process.env.OWNER_CHAT_ID || '',
      plan: 'enterprise'
    });
    console.log('[Tenant] Создан арендатор default из env');
  }
  // Регистрируем известные каналы текущего деплоя на default
  const channels = [];
  if (process.env.WA_PHONE_NUMBER_ID) channels.push(`wa:${process.env.WA_PHONE_NUMBER_ID}`);
  // tg/vk идентификаторы каналов привязываются при первом событии (фаза S2) —
  // здесь регистрируем то, что известно из env заранее.
  for (const ch of channels) registerChannel(ch, DEFAULT_TENANT);
}
