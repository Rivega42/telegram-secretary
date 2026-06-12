/**
 * api.js — клиент WhatsApp Business Cloud API (Meta Graph)
 *
 * env: WA_TOKEN (permanent token), WA_PHONE_NUMBER_ID, WA_API_VERSION (v21.0).
 * Уважает DRY_RUN. Ограничение платформы: писать первым можно только
 * утверждёнными шаблонами; мы отвечаем на входящие — это всегда внутри
 * 24-часового окна.
 */

const WA_API_VERSION = process.env.WA_API_VERSION || 'v21.0';
const WA_TIMEOUT_MS = parseInt(process.env.WA_TIMEOUT_MS || '20000', 10);

export function isWaConfigured() {
  return !!(process.env.WA_TOKEN && process.env.WA_PHONE_NUMBER_ID && process.env.WA_VERIFY_TOKEN);
}

export async function sendWaMessage(toWaId, text) {
  if (process.env.DRY_RUN === 'true') {
    console.log(`[DRY_RUN] WA send → ${toWaId}: ${text.slice(0, 80)}`);
    return { ok: true, dry_run: true };
  }
  const token = process.env.WA_TOKEN;
  const phoneId = process.env.WA_PHONE_NUMBER_ID;
  if (!token || !phoneId) return { ok: false, error: 'WA_TOKEN / WA_PHONE_NUMBER_ID not set' };

  try {
    const r = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(WA_TIMEOUT_MS),
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toWaId,
        type: 'text',
        text: { body: text }
      })
    });
    const data = await r.json();
    if (data.error) {
      console.error('[WA] send error:', data.error.message);
      return { ok: false, error: data.error.message };
    }
    return { ok: true, response: data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
