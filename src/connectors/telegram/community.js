/**
 * community.js — публичные поверхности Telegram: комментарии канала и групповой чат
 *
 * Бот уведомлений (он же community-бот) добавляется в discussion-группу канала
 * или обычную группу. Апдейты приходят через тот же long-polling (control.js
 * маршрутизирует сюда сообщения из групп).
 *
 * Поверхности:
 *   comments — reply в треде поста канала (msg.reply_to_message.is_automatic_forward
 *              или сообщение в message_thread_id треда автофорварда)
 *   group    — остальные сообщения группы
 *
 * Когда отвечаем (триггеры, иначе молчим):
 *   - упоминание @бота
 *   - reply на сообщение бота
 *   - в комментариях: вопрос («?») к посту
 *
 * Безопасность публичных ответов:
 *   - rate-limit на человека и чат (core/ratelimit.js)
 *   - по умолчанию draft: ответ уходит только после «📤» владельца
 *     (PUBLIC_AUTO_REPLY=true — отключить подтверждение, не рекомендуется)
 *   - публичная персона (persona/public.md) с включённым disclosure
 *   - память: разовые комментаторы не записываются в историю диалогов
 */

import { createEnvelope } from '../../core/envelope.js';
import { respond as brainRespond } from '../../core/brain.js';
import { loadPersona } from '../../core/persona.js';
import { resolvePerson } from '../../core/identity.js';
import { allowReply } from '../../core/ratelimit.js';
import { saveDraft } from '../../core/drafts.js';
import { truncate, usernameDisplay } from '../../core/format.js';
import { sendGroupReply, notifyOwnerText } from '../../forward.js';
import { getConversationHistory, appendConversationHistory } from '../../state.js';
import { recordLead, exportLeadToCrm } from '../../core/leads.js';

const PUBLIC_AUTO_REPLY = () => process.env.PUBLIC_AUTO_REPLY === 'true';

/**
 * Классификация сообщения группы: comments / group / null (служебное).
 */
export function classifySurface(msg) {
  if (!msg.chat || !['group', 'supergroup'].includes(msg.chat.type)) return null;
  if (msg.is_automatic_forward) return null; // сам автофорвард поста — не комментарий
  if (msg.reply_to_message?.is_automatic_forward) return 'comments';
  return 'group';
}

/**
 * Надо ли отвечать (триггеры). botUsername и botId — данные community-бота.
 */
export function shouldReply(msg, surface, { botUsername, botId }) {
  const text = msg.text || msg.caption || '';
  if (!text) return false;

  const mentioned = botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
  const replyToBot = msg.reply_to_message?.from?.id && String(msg.reply_to_message.from.id) === String(botId);
  if (mentioned || replyToBot) return true;
  if (surface === 'comments' && text.includes('?')) return true;
  return false;
}

export function toEnvelope(msg, surface) {
  return createEnvelope({
    platform: 'telegram',
    surface,
    identity: {
      platform_user_id: msg.from.id,
      username: msg.from.username || null,
      display_name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ')
    },
    threadKey: `telegram:${surface}:${msg.chat.id}:${msg.message_thread_id || msg.message_id}`,
    text: msg.text || msg.caption || '',
    capabilities: { typing: false, read_receipt: false, buttons: false, edit: false },
    raw: {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      chat_title: msg.chat.title || '',
      // текст поста канала — контекст для ответа на комментарий
      post_text: msg.reply_to_message?.is_automatic_forward
        ? (msg.reply_to_message.text || msg.reply_to_message.caption || '')
        : ''
    }
  });
}

/**
 * Обработать сообщение из группы. Возвращает описание результата (для логов/тестов).
 */
export async function handleGroupMessage(msg, botInfo) {
  const surface = classifySurface(msg);
  if (!surface) return { action: 'skip', reason: 'not-a-group-message' };

  if (!shouldReply(msg, surface, botInfo)) {
    return { action: 'skip', reason: 'no-trigger' };
  }

  if (!allowReply(msg.chat.id, msg.from.id)) {
    console.log(`[Community] rate-limit: chat ${msg.chat.id}, user ${msg.from.id}`);
    return { action: 'skip', reason: 'rate-limit' };
  }

  const envelope = toEnvelope(msg, surface);
  const persona = loadPersona();
  const person = resolvePerson({
    platform: 'telegram',
    platformUserId: envelope.identity.platform_user_id,
    displayName: envelope.identity.display_name,
    username: envelope.identity.username
  });

  // Политики действуют и в публичных поверхностях
  if (person.policy === 'ignore') return { action: 'skip', reason: 'policy-ignore' };

  // Контекст поста — в текст запроса (история группы не ведётся: память не засоряем)
  const enrichedEnvelope = envelope.raw.post_text
    ? { ...envelope, text: `Пост канала: «${truncate(envelope.raw.post_text, 500)}»\n\nКомментарий: ${envelope.text}` }
    : envelope;

  const brainResult = await brainRespond(enrichedEnvelope, { persona, person, history: [], isFirstTime: true });
  if (!brainResult.ok && !brainResult.text) {
    return { action: 'skip', reason: 'brain-error' };
  }

  const surfaceLabel = surface === 'comments' ? 'комментарий' : 'чат';

  // Публичный ответ — по умолчанию через подтверждение владельца
  if (!PUBLIC_AUTO_REPLY()) {
    const draftKey = `pub:${msg.chat.id}:${msg.message_id}`;
    saveDraft(draftKey, {
      kind: 'community',
      text: brainResult.text,
      chat_id: msg.chat.id,
      reply_to: msg.message_id,
      original_text: envelope.text,
      person_id: person.id,
      envelope
    });
    await notifyOwnerText(
      `📣 Черновик в ${surfaceLabel} «${envelope.raw.chat_title}» для ${usernameDisplay(envelope.identity)}:\n\n` +
      `«${brainResult.text}»\n\n` +
      `На: «${truncate(envelope.text, 200)}»`,
      {
        buttons: [[
          { text: '📤 Опубликовать', callback_data: `draft:ok:${draftKey}` },
          { text: '🔄 Переписать', callback_data: `draft:rw:${draftKey}` },
          { text: '🗑 Отбросить', callback_data: `draft:no:${draftKey}` }
        ]]
      }
    );
    return { action: 'draft', draftKey };
  }

  const sendResult = await sendGroupReply(msg.chat.id, msg.message_id, brainResult.text);
  return sendResult.ok
    ? { action: 'replied' }
    : { action: 'skip', reason: `send-failed: ${sendResult.error || sendResult.description}` };
}

/**
 * Лид-воронка (#20): незнакомец пишет в личку бота (например, по кнопке
 * «Спросить ассистента» под постом: t.me/<bot>?start=post_<id>).
 *
 * Бот отвечает сразу (это явный бот — раскрытие очевидно, surface group =
 * публичная персона), ведёт историю lead-диалога и уведомляет владельца
 * о новом/горячем лиде с источником из deep-link.
 */
export async function handleLeadMessage(msg) {
  if (!msg.chat || msg.chat.type !== 'private' || !msg.from) {
    return { action: 'skip', reason: 'not-private' };
  }
  const text = msg.text || msg.caption || '';
  if (!text) return { action: 'skip', reason: 'non-text' };

  const person = resolvePerson({
    platform: 'telegram',
    platformUserId: msg.from.id,
    displayName: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' '),
    username: msg.from.username || null
  });
  if (person.policy === 'ignore') return { action: 'skip', reason: 'policy-ignore' };

  if (!allowReply(`lead:${msg.chat.id}`, msg.from.id)) {
    return { action: 'skip', reason: 'rate-limit' };
  }

  // deep-link источник: /start post_123
  const startMatch = text.match(/^\/start\s+(\S+)/);
  const source = startMatch ? startMatch[1] : null;
  const leadKey = `lead-${msg.from.id}`;
  const userText = startMatch ? 'Здравствуйте!' : text;

  appendConversationHistory(leadKey, 'client', source ? `[пришёл с: ${source}] ${userText}` : userText);
  const history = getConversationHistory(leadKey, 25);

  const persona = loadPersona();
  const envelope = createEnvelope({
    platform: 'telegram',
    surface: 'group', // публичная персона: это официальный бот, без флирта, с раскрытием
    identity: {
      platform_user_id: msg.from.id,
      username: msg.from.username || null,
      display_name: person.display_name
    },
    threadKey: `telegram:lead:${msg.chat.id}`,
    text: userText,
    raw: { chat_id: msg.chat.id }
  });

  const brainResult = await brainRespond(envelope, {
    persona, person, history, isFirstTime: history.length <= 1
  });

  const sendResult = await sendGroupReply(msg.chat.id, null, brainResult.text);
  if (sendResult.ok) {
    appendConversationHistory(leadKey, 'vika', brainResult.text);
  }

  // Сохраняем лид со статусом + выгрузка в CRM (если настроена)
  const { lead, isNew } = recordLead({
    personId: person.id, platform: 'telegram', source,
    displayName: person.display_name, firstMessage: text
  });
  if (isNew) exportLeadToCrm(lead).catch(() => {});

  // Уведомление владельцу: новый лид или продолжение диалога
  if (isNew || source || history.length <= 1) {
    await notifyOwnerText(
      `🔥 Лид в боте: ${usernameDisplay(envelope.identity)} (${person.display_name || '—'})` +
      (source ? `\nИсточник: ${source}` : '') +
      `\n«${truncate(text, 200)}»\n\nОтветила: «${truncate(brainResult.text, 200)}»`,
      { buttons: [[
        { text: '✅ В работе', callback_data: `lead:working:${person.id}` },
        { text: '💰 Продано', callback_data: `lead:won:${person.id}` },
        { text: '❌ Потерян', callback_data: `lead:lost:${person.id}` }
      ], [
        { text: '🔇 Игнорить', callback_data: `pol:ignore:${person.id}` }
      ]] }
    );
  }

  return { action: 'lead-replied', person_id: person.id, source };
}
