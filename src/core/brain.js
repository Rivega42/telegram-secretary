/**
 * brain.js — единая точка генерации ответа для всех коннекторов
 *
 *   respond(envelope, ctx) → { ok, text, error?, model?, usage?, dry_run? }
 *
 * ctx: { persona, person, history, isFirstTime }
 *
 * Драйвер выбирается per-instance (поле driver в instances.json),
 * глобальный дефолт — env BRAIN_DRIVER (stateless-llm | openclaw).
 * При любой ошибке возвращается fallback-ответ из персоны — наружу
 * никогда не уходит пустота или стектрейс.
 */

import { routingKey } from './envelope.js';
import { getInstanceFor } from './instances.js';
import { getTenantInstance } from './tenant-llm.js';
import { loadPersona } from './persona.js';
import { checkQuota, recordUsage } from './billing.js';
import * as statelessLlm from '../brains/stateless-llm.js';
import * as openclaw from '../brains/openclaw.js';

const DRIVERS = {
  'stateless-llm': statelessLlm,
  'openclaw': openclaw
};

function isDryRun() {
  // DRY_RUN_VIKA — историческое имя, поддерживается для совместимости
  return process.env.DRY_RUN_BRAIN === 'true' || process.env.DRY_RUN_VIKA === 'true';
}

export async function respond(envelope, ctx = {}) {
  const persona = ctx.persona || loadPersona();

  // Лимиты тарифа/статус арендатора — ДО генерации (экономим LLM при превышении).
  // limited:true сигналит коннекторам не отправлять ответ клиенту (см. callers).
  const quota = checkQuota(envelope.platform);
  if (!quota.allowed) {
    return { ok: false, limited: true, reason: quota.reason, text: '' };
  }

  if (isDryRun()) {
    recordUsage('replies', 1);
    return { ok: true, text: persona.dry_run_reply, dry_run: true };
  }

  // BYO-LLM арендатора (Enterprise) переопределяет глобальный routing; иначе —
  // instances.json/env. Свой LLM резолвится по текущему арендатору (контекст).
  let instance = getTenantInstance();
  if (!instance) {
    try {
      instance = getInstanceFor(routingKey(envelope));
    } catch (err) {
      console.error('[Brain]', err.message);
      return { ok: false, error: err.message, text: persona.fallback_reply };
    }
  }

  const driverName = instance.driver || process.env.BRAIN_DRIVER || 'stateless-llm';
  const driver = DRIVERS[driverName];
  if (!driver) {
    const error = `unknown brain driver "${driverName}" (known: ${Object.keys(DRIVERS).join(', ')})`;
    console.error('[Brain]', error);
    return { ok: false, error, text: persona.fallback_reply };
  }

  const result = await driver.respond(envelope, { ...ctx, persona }, instance);
  if (!result.ok) {
    return { ...result, text: persona.fallback_reply };
  }
  // Учёт расхода: ответ + токены (если endpoint вернул usage)
  recordUsage('replies', 1);
  const tokens = result.usage?.total_tokens;
  if (tokens) recordUsage('tokens', tokens);
  return result;
}
