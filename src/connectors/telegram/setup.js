/**
 * setup.js — подключение Telegram-бота арендатора (SaaS, фаза S5)
 *
 * Самостоятельный онбординг: по bot-токену арендатора получить @username/id
 * (getMe) и зарегистрировать вебхук (setWebhook) с per-tenant секретом, по
 * которому входящий апдейт резолвится в нужного арендатора.
 *
 * Telegram-специфика (методы Bot API, allowed_updates) живёт только здесь —
 * ядро/онбординг видят лишь нейтральный результат. Уважает DRY_RUN.
 */

const DRY_RUN = process.env.DRY_RUN === 'true';
const TG_TIMEOUT_MS = parseInt(process.env.TG_TIMEOUT_MS || '15000', 10);

/** Детерминированный фейковый bot_id из токена — чтобы в DRY_RUN/тестах
 *  разные токены давали разные каналы (tg:<bot_id>), без обращения к сети. */
function fakeBotId(token) {
  let h = 0;
  for (const ch of String(token)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 100000 + (h % 9000000);
}

async function api(token, method, body = {}) {
  if (DRY_RUN) {
    console.log(`[DRY_RUN] Telegram setup: ${method}`);
    if (method === 'getMe') {
      const id = fakeBotId(token);
      return { ok: true, result: { id, is_bot: true, username: `dry_${id}`, first_name: 'DryBot' } };
    }
    return { ok: true, result: true };
  }

  const url = `https://api.telegram.org/bot${token}/${method}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(TG_TIMEOUT_MS),
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch (err) {
    console.error(`[TG setup] ${method} error:`, err.message);
    return { ok: false, error: err.message };
  }
}

/** Кто этот бот (валидация токена + получение username/id). */
export async function getMe(token) {
  return api(token, 'getMe');
}

/**
 * Зарегистрировать вебхук бота арендатора. secretToken попадёт в заголовок
 * X-Telegram-Bot-Api-Secret-Token каждого апдейта → резолв арендатора.
 */
export async function setWebhook(token, url, secretToken) {
  return api(token, 'setWebhook', {
    url,
    ...(secretToken ? { secret_token: secretToken } : {}),
    allowed_updates: ['business_connection', 'business_message', 'message', 'callback_query']
  });
}

/** Снять вебхук (отключение бота). */
export async function deleteWebhook(token) {
  return api(token, 'deleteWebhook');
}
