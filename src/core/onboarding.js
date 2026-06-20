/**
 * onboarding.js — самостоятельное подключение арендатора (SaaS, фаза S5)
 *
 * Без участия разработчика: регистрация арендатора → подключение бота
 * (getMe + setWebhook) → форма персоны → мастер проверки готовности → бой.
 *
 * Оркестрация поверх реестра (tenant.js), персоны (persona.js), режимов
 * (modes.js) и биллинга (billing.js). Telegram-специфика — в connectors.
 *
 * См. docs/saas-architecture.md (раздел S5).
 */

import crypto from 'crypto';
import {
  getTenant, createTenant, registerChannel, listChannels,
  getTenantSecret, setTenantSecret, listTenantSecretKeys
} from './tenant.js';
import { setTenantPersona, getTenantPersonaRaw } from './persona.js';
import { getSettings } from './modes.js';
import { checkQuota, usageSummary } from './billing.js';
import { runWithTenant } from './context.js';
import { getDb } from './db.js';
import { getMe, setWebhook } from '../connectors/telegram/setup.js';

/** База публичного URL для вебхуков (без хвостового слеша). */
function webhookBase() {
  return (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
}

/**
 * Подключить Telegram-бота к арендатору: валидировать токен, привязать канал
 * tg:<bot_id>, сохранить секреты, зарегистрировать вебхук.
 */
export async function connectTelegram(tenantId, { botToken, webhookBase: baseOverride } = {}) {
  const tenant = getTenant(tenantId);
  if (!tenant) return { ok: false, error: 'tenant not found' };
  if (!botToken) return { ok: false, error: 'bot_token обязателен' };

  const me = await getMe(botToken);
  if (!me.ok) return { ok: false, error: `Telegram getMe: ${me.description || me.error || 'не удалось'}` };
  const bot = me.result;
  const channelKey = `tg:${bot.id}`;

  // Не даём перехватить чужой бот: если канал уже за другим арендатором — отказ
  const existing = getDb().prepare('SELECT tenant_id FROM tenant_channels WHERE channel_key = ?').get(channelKey);
  if (existing && existing.tenant_id !== tenantId) {
    return { ok: false, error: `бот @${bot.username} уже привязан к арендатору "${existing.tenant_id}"` };
  }

  // Per-tenant секрет вебхука: по нему входящий апдейт резолвится в арендатора
  let secret = getTenantSecret(tenantId, 'tg_webhook_secret');
  if (!secret) {
    secret = crypto.randomBytes(16).toString('hex');
    setTenantSecret(tenantId, 'tg_webhook_secret', secret);
  }
  setTenantSecret(tenantId, 'tg_bot_token', botToken);
  registerChannel(channelKey, tenantId);

  // setWebhook — только если известен публичный URL (иначе настроится позже)
  const base = baseOverride ? baseOverride.replace(/\/+$/, '') : webhookBase();
  let webhook = { ok: false, skipped: true };
  if (base) {
    webhook = await setWebhook(botToken, `${base}/tg/business-webhook`, secret);
  }

  return {
    ok: true,
    bot: { id: bot.id, username: bot.username },
    channel_key: channelKey,
    webhook_set: !!webhook.ok && !webhook.skipped,
    webhook_skipped: !base,
    webhook_error: webhook.ok || webhook.skipped ? undefined : (webhook.description || webhook.error)
  };
}

/**
 * Мастер готовности: проверки конфигурации перед боем. ready=true, если нет
 * ни одного fail. warn — мягкое предупреждение (работать можно).
 */
export function checkReadiness(tenantId) {
  const tenant = getTenant(tenantId);
  if (!tenant) return { ok: false, error: 'tenant not found' };

  const checks = [];
  const add = (id, label, status, detail = '') => checks.push({ id, label, status, detail });

  add('status', 'Арендатор активен', tenant.status === 'active' ? 'ok' : 'fail', `status=${tenant.status}`);
  add('owner', 'Указан владелец (owner_chat_id)',
    tenant.owner_chat_id ? 'ok' : 'warn',
    tenant.owner_chat_id ? '' : 'без него не уйдут уведомления и копии ответов');

  const channels = listChannels(tenantId);
  add('channels', 'Привязан хотя бы один канал',
    channels.length ? 'ok' : 'fail', channels.join(', ') || 'каналов нет');

  const secrets = listTenantSecretKeys(tenantId);
  add('bot', 'Подключён бот (токен сохранён)',
    secrets.includes('tg_bot_token') ? 'ok' : (channels.length ? 'warn' : 'fail'),
    secrets.includes('tg_bot_token') ? '' : 'нет tg_bot_token — вебхук не настроить');

  // Персона: для default допустим файловый фоллбек, иначе нужна запись в БД
  const persona = getTenantPersonaRaw(tenantId);
  const personaOk = !!persona || tenantId === 'default';
  add('persona', 'Настроена персона',
    personaOk ? 'ok' : 'warn',
    personaOk ? '' : 'используется нейтральный фоллбек — задай имя/тон через API');

  const settings = runWithTenant(tenantId, () => getSettings());
  add('mode', 'Режим автоответов',
    settings.mode === 'off' ? 'warn' : 'ok',
    `mode=${settings.mode}${settings.draft ? ' (draft: только черновики)' : ''}`);

  const quota = runWithTenant(tenantId, () => checkQuota());
  add('quota', 'Лимит тарифа не исчерпан',
    quota.allowed ? 'ok' : 'fail', quota.reason || `plan=${tenant.plan}`);

  const ready = !checks.some(c => c.status === 'fail');
  return { ok: true, tenant_id: tenantId, ready, checks, usage: usageSummary(tenantId) };
}

/**
 * Сквозной онбординг: создать арендатора (если нет) → персона → бот → готовность.
 * Идемпотентно по id (повторный вызов дополняет существующего).
 */
export async function onboard({ id, name, owner_chat_id, plan, persona, bot_token, webhook_base } = {}) {
  let tenant = getTenant(id);
  if (!tenant) {
    const created = createTenant({ id, name, ownerChatId: owner_chat_id, plan });
    if (!created.ok) return created;
    tenant = created.tenant;
  }

  const result = { ok: true, tenant_id: tenant.id, created: tenant.created_at };

  if (persona && Object.keys(persona).length) {
    setTenantPersona(id, persona);
    result.persona = true;
  }

  if (bot_token) {
    result.telegram = await connectTelegram(id, { botToken: bot_token, webhookBase: webhook_base });
  }

  result.readiness = checkReadiness(id);
  return result;
}
