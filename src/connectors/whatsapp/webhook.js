/**
 * webhook.js — WhatsApp Business Cloud API (Meta Graph), личка бизнес-номера
 *
 * GET  /wa/webhook — верификация подписки (hub.verify_token === WA_VERIFY_TOKEN)
 * POST /wa/webhook — события: messages → персона → политика → Brain → ответ
 *
 * Подлинность: подпись X-Hub-Signature-256 (HMAC-SHA256 от raw body ключом
 * WA_APP_SECRET) — проверяется, если секрет задан.
 *
 * Как и ВК: бизнес-номер — явный «офис», отвечаем сразу (всегда внутри
 * 24-часового окна, т.к. отвечаем на входящее). Глобальный /draft и политики
 * персон действуют. История wa-<wa_id>. Склейка персон — по подтверждению.
 */

import crypto from 'crypto';
import { createEnvelope } from '../../core/envelope.js';
import { respond as brainRespond } from '../../core/brain.js';
import { loadPersona } from '../../core/persona.js';
import { resolvePerson, findSimilarPersons } from '../../core/identity.js';
import { getSettings } from '../../core/modes.js';
import { saveDraft } from '../../core/drafts.js';
import { truncate } from '../../core/format.js';
import { getConversationHistory, appendConversationHistory, logUpdate, markProcessed, unmarkProcessed } from '../../state.js';
import { runWithTenant } from '../../core/context.js';
import { resolveTenant } from '../../core/tenant.js';
import { notifyOwnerText } from '../../forward.js';
import { sendWaMessage, isWaConfigured } from './api.js';

export function toEnvelope(message, contactName = '') {
  return createEnvelope({
    platform: 'whatsapp',
    surface: 'dm',
    identity: {
      platform_user_id: message.from, // wa_id (номер)
      username: null,
      display_name: contactName
    },
    threadKey: `whatsapp:dm:${message.from}`,
    text: message.text?.body || '',
    capabilities: { typing: false, read_receipt: false, buttons: false, edit: false },
    raw: { wa_id: message.from, message_id: message.id, message_type: message.type }
  });
}

async function suggestMerge(person) {
  const similar = findSimilarPersons(person);
  if (!similar.length) return;
  const candidate = similar[0];
  await notifyOwnerText(
    `🔗 Похоже, ${person.display_name || person.id} из WhatsApp — это уже знакомый ` +
    `${candidate.display_name || candidate.username || candidate.id} (совпадение: имя).\nОбъединить память?`,
    {
      buttons: [[
        { text: '✅ Это один человек', callback_data: `merge:${candidate.id}:${person.id}` },
        { text: '❌ Разные люди', callback_data: 'merge:no:-' }
      ]]
    }
  );
}

/**
 * Обработать одно входящее сообщение. Возвращает описание результата.
 */
export async function handleWaMessage(message, contactName = '') {
  const envelope = toEnvelope(message, contactName);
  const persona = loadPersona();
  const person = resolvePerson({
    platform: 'whatsapp',
    platformUserId: envelope.identity.platform_user_id,
    displayName: contactName
  });

  if (person.isNew) await suggestMerge(person);
  if (person.policy === 'ignore') return { action: 'skip', reason: 'policy-ignore' };

  const threadId = `wa-${message.from}`;

  if (!envelope.text) {
    await notifyOwnerText(`📎 [WA] Не-текстовое сообщение (${message.type}) от ${contactName || message.from} — ответь сам.`);
    return { action: 'skip', reason: 'non-text' };
  }

  appendConversationHistory(threadId, 'client', envelope.text);

  if (person.policy === 'escalate') {
    await notifyOwnerText(
      `🔴 [WA Эскалация] ${contactName || message.from}:\n«${truncate(envelope.text, 300)}»\n\nАвтоответ отключён политикой — ответь сам.`
    );
    return { action: 'escalated', person_id: person.id };
  }

  const history = getConversationHistory(threadId, 25);
  const brainResult = await brainRespond(envelope, {
    persona, person, history, isFirstTime: history.length <= 1
  });

  // Лимит тарифа/приостановка — не отвечаем
  if (brainResult.limited) {
    return { action: 'skip', reason: `limited:${brainResult.reason}`, person_id: person.id };
  }

  if (getSettings().draft) {
    const draftKey = `wa:${message.from}:${message.id || Date.now()}`;
    saveDraft(draftKey, {
      kind: 'wa',
      text: brainResult.text,
      wa_id: message.from,
      thread_id: threadId,
      original_text: envelope.text,
      person_id: person.id,
      envelope
    });
    await notifyOwnerText(
      `📝 [WA] Черновик для ${contactName || message.from}:\n\n«${brainResult.text}»\n\nНа: «${truncate(envelope.text, 200)}»`,
      {
        buttons: [[
          { text: '📤 Отправить', callback_data: `draft:ok:${draftKey}` },
          { text: '🔄 Переписать', callback_data: `draft:rw:${draftKey}` },
          { text: '🗑 Отбросить', callback_data: `draft:no:${draftKey}` }
        ]]
      }
    );
    return { action: 'draft', draftKey, person_id: person.id };
  }

  const sendResult = await sendWaMessage(message.from, brainResult.text);
  if (sendResult.ok) {
    appendConversationHistory(threadId, 'vika', brainResult.text);
  }

  await notifyOwnerText(
    `💼 [WA → ${contactName || message.from}]\nПолучено: «${truncate(envelope.text, 200)}»\n` +
    `Ответила: «${truncate(brainResult.text, 300)}»` +
    (sendResult.ok ? '' : '\n⚠️ ОТПРАВКА НЕ УДАЛАСЬ')
  );

  return sendResult.ok
    ? { action: 'replied', person_id: person.id }
    : { action: 'skip', reason: `send-failed: ${sendResult.error}` };
}

/**
 * GET-верификация подписки webhook (настройка приложения Meta).
 */
export function waVerifyHandler(req, res) {
  if (!isWaConfigured()) return res.status(503).send('not configured');
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === process.env.WA_VERIFY_TOKEN) {
    return res.send(req.query['hub.challenge']);
  }
  return res.status(403).send('forbidden');
}

/**
 * Проверка подписи X-Hub-Signature-256 (если задан WA_APP_SECRET).
 * rawBody сохраняется в express.json({ verify }) — см. app.js.
 */
export function isValidSignature(req) {
  const secret = process.env.WA_APP_SECRET;
  if (!secret) return true; // проверка выключена
  const header = req.headers['x-hub-signature-256'] || '';
  if (!req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * POST-обработчик событий.
 */
export async function waWebhookHandler(req, res) {
  if (!isWaConfigured()) return res.status(503).json({ error: 'WhatsApp connector not configured' });
  if (!isValidSignature(req)) {
    console.warn('[WA] Invalid webhook signature');
    return res.status(403).send('forbidden');
  }

  // Meta ретраит до 200 — отвечаем сразу, обрабатываем асинхронно
  res.send('ok');

  try {
    for (const entry of req.body?.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        // Резолв арендатора по бизнес-номеру (wa:<phone_number_id>); не найден → default
        const phoneId = value.metadata?.phone_number_id || process.env.WA_PHONE_NUMBER_ID;
        const tenantId = resolveTenant(`wa:${phoneId}`)?.id || 'default';
        const contacts = Object.fromEntries(
          (value.contacts || []).map(c => [c.wa_id, c.profile?.name || ''])
        );
        for (const message of value.messages || []) {
          const key = `wa:${message.id}`;
          // Персистентная дедупликация — переживает рестарт
          if (!markProcessed(key)) continue;
          logUpdate({ update_id: key, wa: true, type: message.type });
          try {
            await runWithTenant(tenantId, async () => {
              const result = await handleWaMessage(message, contacts[message.from] || '');
              console.log(`[WA] message → ${result.action}${result.reason ? ` (${result.reason})` : ''}`);
            });
          } catch (err) {
            console.error('[WA] Error handling message:', err);
            unmarkProcessed(key); // дать Meta повторить доставку
          }
        }
        // statuses (доставлено/прочитано) — игнорируем
      }
    }
  } catch (err) {
    console.error('[WA] Error handling event:', err);
  }
}
