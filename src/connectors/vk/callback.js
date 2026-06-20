/**
 * callback.js — Callback API сообщества ВКонтакте (личные сообщения)
 *
 * POST /vk/callback:
 *   confirmation → вернуть VK_CONFIRMATION_CODE
 *   message_new  → персона → политика → Brain → ответ от сообщества
 *   остальное    → 'ok'
 *
 * Проверка подлинности: VK_SECRET (поле secret в каждом событии).
 *
 * Поведение (в отличие от telegram-лички владельца): сообщество — это явный
 * «офис» владельца, поэтому отвечаем сразу, без отложенного pending.
 * Глобальный draft-режим уважается: при включённом /draft ответ идёт
 * черновиком владельцу (kind 'vk').
 *
 * Единая память: vk-пользователь резолвится в персону; при совпадении
 * username/имени с telegram-персоной владельцу предлагается склейка
 * (кнопка — слияние ТОЛЬКО по подтверждению, #10).
 */

import { createEnvelope } from '../../core/envelope.js';
import { respond as brainRespond } from '../../core/brain.js';
import { loadPersona } from '../../core/persona.js';
import { resolvePerson, findSimilarPersons } from '../../core/identity.js';
import { getSettings } from '../../core/modes.js';
import { saveDraft } from '../../core/drafts.js';
import { truncate, usernameDisplay, timingSafeEqualStr } from '../../core/format.js';
import { getConversationHistory, appendConversationHistory, logUpdate, markProcessed, unmarkProcessed } from '../../state.js';
import { runWithTenant } from '../../core/context.js';
import { resolveTenant } from '../../core/tenant.js';
import { notifyOwnerText } from '../../forward.js';
import { sendVkMessage, vkApi, isVkConfigured } from './api.js';

function vkDisplayName(profile) {
  return [profile?.first_name, profile?.last_name].filter(Boolean).join(' ');
}

export function toEnvelope(message, profile = {}) {
  return createEnvelope({
    platform: 'vk',
    surface: 'dm',
    identity: {
      platform_user_id: message.from_id,
      username: profile.screen_name || null,
      display_name: vkDisplayName(profile)
    },
    threadKey: `vk:dm:${message.peer_id}`,
    text: message.text || '',
    capabilities: { typing: false, read_receipt: false, buttons: false, edit: false },
    raw: { peer_id: message.peer_id, message_id: message.id }
  });
}

/**
 * Предложить владельцу склейку, если новая vk-персона похожа на существующую.
 */
async function suggestMerge(person) {
  const similar = findSimilarPersons(person);
  if (!similar.length) return;
  const candidate = similar[0];
  await notifyOwnerText(
    `🔗 Похоже, ${person.display_name || person.username || person.id} из ВК — это уже знакомый ` +
    `${candidate.display_name || candidate.username || candidate.id} ` +
    `(совпадение: ${candidate.match === 'username' ? 'username' : 'имя'}).\n` +
    `Объединить память о них?`,
    {
      buttons: [[
        { text: '✅ Это один человек', callback_data: `merge:${candidate.id}:${person.id}` },
        { text: '❌ Разные люди', callback_data: 'merge:no:-' }
      ]]
    }
  );
}

/**
 * Обработать message_new. Возвращает описание результата (для логов/тестов).
 */
export async function handleVkMessage(message, profile = {}) {
  if (!message?.from_id || message.from_id < 0) {
    return { action: 'skip', reason: 'not-a-user' }; // сообщения от сообществ/служебные
  }

  const envelope = toEnvelope(message, profile);
  const persona = loadPersona();
  const person = resolvePerson({
    platform: 'vk',
    platformUserId: envelope.identity.platform_user_id,
    displayName: envelope.identity.display_name,
    username: envelope.identity.username
  });

  if (person.isNew) await suggestMerge({ ...person, id: person.id });
  if (person.policy === 'ignore') return { action: 'skip', reason: 'policy-ignore' };

  const threadId = `vk-${message.peer_id}`;
  const senderDisplay = usernameDisplay(envelope.identity);

  if (!envelope.text) {
    await notifyOwnerText(`📎 [VK] Не-текстовое сообщение от ${senderDisplay} (${person.display_name || '—'}) — ответь сам: vk.com/gim?sel=${message.peer_id}`);
    return { action: 'skip', reason: 'non-text' };
  }

  appendConversationHistory(threadId, 'client', envelope.text);

  // Политика escalate: без LLM, сразу владельцу
  if (person.policy === 'escalate') {
    await notifyOwnerText(
      `🔴 [VK Эскалация] ${senderDisplay} (${person.display_name || '—'}):\n«${truncate(envelope.text, 300)}»\n\nАвтоответ отключён политикой — ответь сам.`
    );
    return { action: 'escalated', person_id: person.id };
  }

  const history = getConversationHistory(threadId, 25);
  const brainResult = await brainRespond(envelope, {
    persona, person, history, isFirstTime: history.length <= 1
  });

  // Лимит тарифа/приостановка — не отвечаем (для VK скрытно, без спама владельцу)
  if (brainResult.limited) {
    return { action: 'skip', reason: `limited:${brainResult.reason}`, person_id: person.id };
  }

  // Глобальный draft-режим действует и для ВК
  if (getSettings().draft) {
    const draftKey = `vk:${message.peer_id}:${message.id ?? Date.now()}`;
    saveDraft(draftKey, {
      kind: 'vk',
      text: brainResult.text,
      peer_id: message.peer_id,
      thread_id: threadId,
      original_text: envelope.text,
      person_id: person.id,
      envelope
    });
    await notifyOwnerText(
      `📝 [VK] Черновик для ${senderDisplay} (${person.display_name || '—'}):\n\n«${brainResult.text}»\n\nНа: «${truncate(envelope.text, 200)}»`,
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

  const sendResult = await sendVkMessage(message.peer_id, brainResult.text);
  if (sendResult.ok) {
    appendConversationHistory(threadId, 'vika', brainResult.text);
  }

  await notifyOwnerText(
    `💼 [VK → ${senderDisplay}]\nПолучено: «${truncate(envelope.text, 200)}»\n` +
    `Ответила: «${truncate(brainResult.text, 300)}»` +
    (sendResult.ok ? '' : '\n⚠️ ОТПРАВКА НЕ УДАЛАСЬ')
  );

  return sendResult.ok
    ? { action: 'replied', person_id: person.id }
    : { action: 'skip', reason: `send-failed: ${sendResult.error}` };
}

/**
 * Профиль отправителя (имя, screen_name) — для персоны. Best effort.
 */
async function fetchProfile(userId) {
  const r = await vkApi('users.get', { user_ids: userId, fields: 'screen_name' });
  return r.ok && Array.isArray(r.response) ? (r.response[0] || {}) : {};
}

/**
 * Express-handler POST /vk/callback.
 */
export async function vkCallbackHandler(req, res) {
  if (!isVkConfigured()) {
    return res.status(503).json({ error: 'VK connector not configured (VK_GROUP_TOKEN, VK_CONFIRMATION_CODE)' });
  }

  const event = req.body || {};

  // Подтверждение сервера при настройке Callback API
  if (event.type === 'confirmation') {
    return res.send(process.env.VK_CONFIRMATION_CODE);
  }

  // Подлинность события
  if (process.env.VK_SECRET && !timingSafeEqualStr(event.secret, process.env.VK_SECRET)) {
    console.warn('[VK] Invalid callback secret');
    return res.status(403).send('forbidden');
  }

  // ВК ретраит, пока не получит 'ok' — отвечаем сразу, обрабатываем асинхронно
  res.send('ok');

  const eventKey = `vk:${event.group_id}:${event.type}:${event.event_id || JSON.stringify(event.object?.message?.id)}`;
  // Персистентная дедупликация — переживает рестарт
  if (!markProcessed(eventKey)) return;

  // Резолв арендатора по сообществу (vk:<group_id>); не найден → default
  const tenantId = resolveTenant(`vk:${event.group_id}`)?.id || 'default';

  try {
    await runWithTenant(tenantId, async () => {
      logUpdate({ update_id: eventKey, vk: true, type: event.type });
      if (event.type === 'message_new') {
        const message = event.object?.message || event.object;
        const profile = await fetchProfile(message.from_id);
        const result = await handleVkMessage(message, profile);
        console.log(`[VK] message_new → ${result.action}${result.reason ? ` (${result.reason})` : ''}`);
      }
    });
  } catch (err) {
    console.error('[VK] Error handling event:', err);
    unmarkProcessed(eventKey); // дать ВК повторить доставку
  }
}
