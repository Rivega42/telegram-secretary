/**
 * tenant-llm.js — свой LLM-инстанс арендатора (BYO-LLM, SaaS Enterprise)
 *
 * Enterprise-арендатор может подключить собственный OpenAI-совместимый endpoint
 * (или OpenClaw): конфиг переопределяет глобальный routing из instances.json
 * для всех поверхностей этого арендатора.
 *
 * Хранение: несекретная часть (driver/base_url/model/stateful) — в
 * tenant_settings.data.llm; api_key — в tenant_secrets (шифруется at-rest,
 * см. secrets-crypto.js). Наружу ключ не отдаётся (только флаг api_key_set).
 *
 * Гейт тарифа: подключение разрешено только планам с capability byo_llm.
 */

import { getDb } from './db.js';
import { currentTenantId } from './context.js';
import { getTenant, getTenantSecret, setTenantSecret } from './tenant.js';
import { planAllowsByoLlm } from './billing.js';

const LLM_DRIVERS = ['stateless-llm', 'openclaw'];

function readSettings(tenantId) {
  const row = getDb().prepare('SELECT data FROM tenant_settings WHERE tenant_id = ?').get(tenantId);
  try { return row ? JSON.parse(row.data) : {}; } catch { return {}; }
}

function writeSettings(tenantId, data) {
  getDb().prepare('INSERT OR REPLACE INTO tenant_settings (tenant_id, data) VALUES (?, ?)')
    .run(tenantId, JSON.stringify(data));
}

/**
 * Подключить/обновить BYO-LLM арендатора. api_key (если передан) шифруется.
 * Частичное обновление: незаданные поля сохраняют прежние значения.
 */
export function setTenantLlm(tenantId, { driver, base_url, model, stateful, api_key, label } = {}) {
  const tenant = getTenant(tenantId);
  if (!tenant) return { ok: false, error: 'tenant not found' };
  if (!planAllowsByoLlm(tenant)) {
    return { ok: false, error: `тариф "${tenant.plan}" не поддерживает свой LLM (нужен enterprise)` };
  }
  if (driver && !LLM_DRIVERS.includes(driver)) {
    return { ok: false, error: `driver: ${LLM_DRIVERS.join(' | ')}` };
  }

  const data = readSettings(tenantId);
  const prev = data.llm || {};
  const llm = {
    driver: driver || prev.driver || 'stateless-llm',
    base_url: (base_url ?? prev.base_url ?? '').replace(/\/+$/, ''),
    model: model ?? prev.model ?? '',
    stateful: stateful ?? prev.stateful ?? false,
    label: label ?? prev.label ?? 'tenant:BYO-LLM',
    updated_at: new Date().toISOString()
  };
  if (!llm.base_url) return { ok: false, error: 'base_url обязателен' };

  data.llm = llm;
  writeSettings(tenantId, data);
  if (api_key !== undefined) setTenantSecret(tenantId, 'llm_api_key', api_key);

  return { ok: true, llm: publicLlm(llm, tenantId) };
}

/** Отключить BYO-LLM (вернуться на глобальный routing). */
export function clearTenantLlm(tenantId) {
  const data = readSettings(tenantId);
  if (!data.llm) return { ok: true, cleared: false };
  delete data.llm;
  writeSettings(tenantId, data);
  return { ok: true, cleared: true };
}

function publicLlm(llm, tenantId) {
  return { ...llm, api_key_set: !!getTenantSecret(tenantId, 'llm_api_key') };
}

/** Конфиг BYO-LLM без секрета (для admin-вывода). null — не настроен. */
export function getTenantLlmPublic(tenantId) {
  const llm = readSettings(tenantId).llm;
  return llm ? publicLlm(llm, tenantId) : null;
}

/**
 * Инстанс BYO-LLM текущего (или указанного) арендатора для core/brain.js.
 * null — арендатор не настроил свой LLM (используется глобальный routing).
 */
export function getTenantInstance(tenantId = currentTenantId()) {
  const llm = readSettings(tenantId).llm;
  if (!llm || !llm.base_url) return null;
  return {
    name: `tenant:${tenantId}`,
    driver: llm.driver || 'stateless-llm',
    base_url: llm.base_url,
    api_key: getTenantSecret(tenantId, 'llm_api_key') || '',
    model: llm.model || '',
    stateful: !!llm.stateful,
    label: llm.label || 'tenant:BYO-LLM'
  };
}
