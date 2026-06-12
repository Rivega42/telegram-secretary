/**
 * api.js — клиент VK API для сообщества
 *
 * Работа только от имени сообщества (Callback API) — автоматизация личной
 * страницы запрещена правилами ВК. Уважает DRY_RUN.
 *
 * env: VK_GROUP_TOKEN (токен сообщества), VK_API_VERSION (по умолчанию 5.199)
 */

const VK_API_VERSION = process.env.VK_API_VERSION || '5.199';
const VK_TIMEOUT_MS = parseInt(process.env.VK_TIMEOUT_MS || '20000', 10);

export function isVkConfigured() {
  return !!(process.env.VK_GROUP_TOKEN && process.env.VK_CONFIRMATION_CODE);
}

export async function vkApi(method, params = {}) {
  if (process.env.DRY_RUN === 'true') {
    console.log(`[DRY_RUN] VK API: ${method}`, JSON.stringify(params));
    return { ok: true, response: { dry_run: true } };
  }
  const token = process.env.VK_GROUP_TOKEN;
  if (!token) return { ok: false, error: 'VK_GROUP_TOKEN not set' };

  try {
    const body = new URLSearchParams({
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      access_token: token,
      v: VK_API_VERSION
    });
    const r = await fetch(`https://api.vk.com/method/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(VK_TIMEOUT_MS),
      body
    });
    const data = await r.json();
    if (data.error) {
      console.error(`[VK] ${method} error:`, data.error.error_msg);
      return { ok: false, error: data.error.error_msg, code: data.error.error_code };
    }
    return { ok: true, response: data.response };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Личное сообщение от имени сообщества.
 */
export async function sendVkMessage(peerId, text) {
  return vkApi('messages.send', {
    peer_id: peerId,
    message: text,
    random_id: Date.now() * 1000 + Math.floor(Math.random() * 1000)
  });
}
