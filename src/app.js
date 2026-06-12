/**
 * app.js — Express-приложение secretary-proxy
 *
 * Поток входящего сообщения (личка Telegram Business):
 *   webhook → коннектор (envelope) → персона/политика → pending → Brain → ответ
 *
 * Политики персон (persons.json):
 *   auto     — отложенный автоответ (по умолчанию)
 *   escalate — без LLM, сразу уведомление владельцу (семья, VIP)
 *   ignore   — не отвечать и не уведомлять (спам)
 *
 * Не-текстовые сообщения (голос, фото и т.п.) не отвечаются автоматически —
 * эскалируются владельцу, чтобы Brain не отвечал невпопад.
 *
 * Endpoints:
 * - POST /tg/business-webhook — приём апдейтов от Telegram
 * - GET  /health — проверка работы
 * - /api/* (X-Api-Key): reply, contacts, conversations, pending, persons
 */

import 'dotenv/config';
import express from 'express';
import {
  markProcessed,
  unmarkProcessed,
  saveConnection,
  updateContact,
  getOrCreateMapping,
  getMapping,
  findMappingByChat,
  logUpdate,
  logOutgoing,
  getContacts,
  getConversations,
  getConversationHistory,
  appendConversationHistory
} from './state.js';
import { sendBusinessReply, notifyOwnerText, editOwnerMessage, sendGroupReply, simulateTyping } from './forward.js';
import { respond as brainRespond } from './core/brain.js';
import { loadPersona } from './core/persona.js';
import { resolvePerson, getPerson, getPersons, setPersonPolicy, mergePersons } from './core/identity.js';
import { createEnvelope } from './core/envelope.js';
import { truncate, usernameDisplay } from './core/format.js';
import { getSettings, VACATION_DELAY_SECONDS } from './core/modes.js';
import { saveDraft, getDraft, deleteDraft } from './core/drafts.js';
import * as telegramBusiness from './connectors/telegram/business.js';
import { isSttConfigured, transcribeVoice } from './connectors/telegram/stt.js';
import { vkCallbackHandler } from './connectors/vk/callback.js';
import { sendVkMessage } from './connectors/vk/api.js';
import {
  setExecuteCallback,
  createPending,
  cancelPending,
  getAllPending,
  getDelayMinutes,
  getPendingTask,
  setPendingNotifyMessageId
} from './scheduler.js';

const HISTORY_CONTEXT_LIMIT = parseInt(process.env.HISTORY_CONTEXT_LIMIT || '25', 10);

export const OWNER_CHAT_ID = String(process.env.OWNER_CHAT_ID || '');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const API_KEY = process.env.API_KEY;

/**
 * Восстановить конверт из pending-задачи. Старые pending.json (до этапа 1)
 * не содержат envelope — реконструируем из полей задачи.
 */
function envelopeFromTask(task) {
  if (task.envelope) return task.envelope;
  return createEnvelope({
    platform: 'telegram',
    surface: 'dm',
    identity: {
      platform_user_id: task.senderInfo?.sender_id || `chat:${task.businessChatId}`,
      username: task.senderInfo?.sender_username || null,
      display_name: task.senderInfo?.sender_name || ''
    },
    threadKey: `telegram:dm:${task.businessChatId}`,
    text: task.originalText,
    capabilities: { typing: true, read_receipt: true },
    raw: {
      business_connection_id: task.businessConnectionId,
      chat_id: task.businessChatId
    }
  });
}

/**
 * Inline-кнопки под уведомлениями владельцу
 */
function pendingButtons(chatId, mappingId, personId) {
  return [
    [
      { text: '⚡ Ответить сейчас', callback_data: `pend:now:${chatId}` },
      { text: '✍️ Свой ответ', callback_data: `rep:${mappingId}` },
      { text: '🚫 Отменить', callback_data: `pend:cancel:${chatId}` }
    ],
    [
      { text: '🔴 Только мне', callback_data: `pol:escalate:${personId}` },
      { text: '🔇 Игнорить', callback_data: `pol:ignore:${personId}` }
    ]
  ];
}

function escalationButtons(mappingId, personId) {
  return [
    [{ text: '✍️ Свой ответ', callback_data: `rep:${mappingId}` }],
    [
      { text: '🟢 Вернуть автоответ', callback_data: `pol:auto:${personId}` },
      { text: '🔇 Игнорить', callback_data: `pol:ignore:${personId}` }
    ]
  ];
}

function draftButtons(mappingId) {
  return [[
    { text: '📤 Отправить', callback_data: `draft:ok:${mappingId}` },
    { text: '🔄 Переписать', callback_data: `draft:rw:${mappingId}` },
    { text: '🗑 Отбросить', callback_data: `draft:no:${mappingId}` }
  ]];
}

/**
 * Ручной/подтверждённый ответ клиенту: отмена pending, отправка, история.
 * Используется /api/reply, кнопкой «Свой ответ» и draft-подтверждением.
 */
export async function sendManualReply(mappingId, text) {
  const mapping = getMapping(mappingId);
  if (!mapping) return { ok: false, error: `Mapping not found: ${mappingId}` };

  cancelPending(mapping.business_chat_id, 'manual reply');

  const result = await sendBusinessReply(
    mapping.business_connection_id,
    mapping.business_chat_id,
    text
  );
  if (result.ok) {
    appendConversationHistory(mappingId, 'vika', text);
  }
  logOutgoing(mappingId, text, result.ok);
  return result.ok
    ? { ok: true, message_id: result.result?.message_id, sent_to: mapping.sender_name }
    : { ok: false, error: result.error || result.description };
}

/**
 * Callback для scheduler — сгенерировать и отправить ответ секретаря
 */
export async function executeBrainResponse(task) {
  console.log(`[Execute] Running brain response for mapping ${task.mappingId}`);

  try {
    const mapping = getMapping(task.mappingId);
    if (!mapping) {
      console.error(`[Execute] Mapping ${task.mappingId} not found`);
      return;
    }

    const envelope = envelopeFromTask(task);
    const persona = loadPersona();
    const person = task.personId
      ? getPerson(task.personId)
      : resolvePerson({
          platform: envelope.platform,
          platformUserId: envelope.identity.platform_user_id,
          displayName: envelope.identity.display_name,
          username: envelope.identity.username
        });

    const history = getConversationHistory(task.mappingId, HISTORY_CONTEXT_LIMIT);
    const isFirstTime = history.length <= 1;

    console.log(`[Execute] Calling brain for mapping ${task.mappingId} (person ${person?.id})...`);
    const brainResult = await brainRespond(envelope, { persona, person, history, isFirstTime });
    console.log(`[Execute] Brain result: ok=${brainResult.ok}${brainResult.dry_run ? ' (dry_run)' : ''}`);

    // Draft-режим: клиенту ничего не уходит — черновик владельцу на подтверждение
    if (getSettings().draft) {
      saveDraft(task.mappingId, {
        text: brainResult.text,
        envelope,
        person_id: person?.id,
        original_text: task.originalText
      });
      await notifyOwnerText(
        `📝 Черновик для ${usernameDisplay(envelope.identity)} (${envelope.identity.display_name}):\n\n` +
        `«${brainResult.text}»\n\n` +
        `На сообщение: «${truncate(task.originalText, 200)}»`,
        { buttons: draftButtons(task.mappingId) }
      );
      return;
    }

    // Реалистичность: прочитано + «печатает…» перед отправкой
    await simulateTyping(
      envelope.raw.business_connection_id,
      envelope.raw.chat_id,
      envelope.raw.message_id,
      brainResult.text.length
    );

    const replyResult = await telegramBusiness.reply(envelope, brainResult.text);
    console.log(`[Execute] Business reply result: ok=${replyResult.ok}`);

    // В историю пишется только то, что реально дошло до клиента,
    // иначе контекст разойдётся с тем, что клиент видел
    if (replyResult.ok) {
      appendConversationHistory(task.mappingId, 'vika', brainResult.text);
    }

    logOutgoing(task.mappingId, brainResult.text, replyResult.ok);

    // Копия владельцу
    await notifyOwnerText(
      `💼 [${persona.secretary_name} → ${usernameDisplay(envelope.identity)}]\n(⏱ отложенный ответ)\n` +
      `Получено: «${truncate(task.originalText, 200)}»\n` +
      `Ответила: «${truncate(brainResult.text, 300)}»` +
      (replyResult.ok ? '' : '\n⚠️ ОТПРАВКА НЕ УДАЛАСЬ')
    );
  } catch (err) {
    console.error('[Execute] Error executing brain response:', err);
  }
}

/**
 * Действия control plane (кнопки/команды владельца) — внедряются
 * в connectors/telegram/control.js из server.js.
 */
export function createControlActions() {
  return {
    sendReplyToClient: (mappingId, text) => sendManualReply(mappingId, text),

    approveDraft: async (draftKey) => {
      const draft = getDraft(draftKey);
      if (!draft) return 'Черновик не найден';

      // Публичный черновик (комментарий/чат) — ответ в группу
      if (draft.kind === 'community') {
        const result = await sendGroupReply(draft.chat_id, draft.reply_to, draft.text);
        if (!result.ok) return `⚠️ ${result.error || result.description}`;
        logOutgoing(draftKey, draft.text, true);
        deleteDraft(draftKey);
        return '📤 Опубликовано';
      }

      // Личное сообщение сообществу ВКонтакте
      if (draft.kind === 'vk') {
        const result = await sendVkMessage(draft.peer_id, draft.text);
        if (!result.ok) return `⚠️ ${result.error}`;
        appendConversationHistory(draft.thread_id, 'vika', draft.text);
        logOutgoing(draftKey, draft.text, true);
        deleteDraft(draftKey);
        return '📤 Отправлено (VK)';
      }

      // Пост в канал (автопостинг)
      if (draft.kind === 'channel') {
        const result = await sendGroupReply(draft.chat_id, null, draft.text);
        if (!result.ok) return `⚠️ ${result.error || result.description}`;
        const { recordPosted } = await import('./connectors/telegram/channel.js');
        recordPosted(draft.topic || '', draft.text);
        logOutgoing(draftKey, draft.text, true);
        deleteDraft(draftKey);
        return '📤 Опубликовано в канал';
      }

      const result = await sendManualReply(draftKey, draft.text);
      if (!result.ok) return `⚠️ ${result.error}`;
      deleteDraft(draftKey);
      return '📤 Отправлено';
    },

    rejectDraft: (mappingId) =>
      deleteDraft(mappingId) ? '🗑 Черновик отброшен' : 'Черновик не найден',

    requestRewrite: async (mappingId, note) => {
      const draft = getDraft(mappingId);
      if (!draft) {
        await notifyOwnerText('Черновик не найден — возможно, уже отправлен или отброшен.');
        return;
      }
      const persona = loadPersona();
      const person = draft.person_id ? getPerson(draft.person_id) : null;
      const history = getConversationHistory(mappingId, HISTORY_CONTEXT_LIMIT);
      const brainResult = await brainRespond(draft.envelope, {
        persona, person, history,
        isFirstTime: false,
        rewrite: { previous: draft.text, note }
      });
      saveDraft(mappingId, { ...draft, text: brainResult.text });
      await notifyOwnerText(
        `📝 Новый вариант:\n\n«${brainResult.text}»`,
        { buttons: draftButtons(mappingId) }
      );
    }
  };
}

/**
 * Человекочитаемая задержка для уведомлений
 */
function delayLabel(delayMinutes) {
  return delayMinutes < 1
    ? `${Math.round(delayMinutes * 60)} сек`
    : `${Math.round(delayMinutes)} мин`;
}

export function createApp() {
  // Scheduler исполняет отложенные ответы через Brain. Регистрация здесь,
  // а не на уровне модуля — чтобы импорт app.js не имел сайд-эффектов.
  setExecuteCallback(executeBrainResponse);

  const app = express();

  app.use(express.json());

  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });

  // Авторизация админ-API: X-Api-Key или Authorization: Bearer
  app.use('/api', (req, res, next) => {
    if (!API_KEY) return next(); // не настроен — предупреждение выводится при старте
    const provided = req.headers['x-api-key']
      || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (provided !== API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  /**
   * Health check
   */
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      env: {
        business_token: !!process.env.BUSINESS_BOT_TOKEN,
        oneint_token: !!process.env.ONEINT_BOT_TOKEN,
        owner_chat_id: process.env.OWNER_CHAT_ID,
        state_dir: process.env.STATE_DIR,
        dry_run: process.env.DRY_RUN === 'true'
      },
      brain_driver: process.env.BRAIN_DRIVER || 'stateless-llm',
      pending_count: Object.keys(getAllPending()).length
    });
  });

  /**
   * Telegram Business Webhook
   */
  app.post('/tg/business-webhook', async (req, res) => {
    if (WEBHOOK_SECRET) {
      const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
      if (headerSecret !== WEBHOOK_SECRET) {
        console.warn('Invalid webhook secret');
        return res.status(403).json({ error: 'Invalid secret' });
      }
    }

    const update = req.body;

    if (!update || !update.update_id) {
      return res.status(400).json({ error: 'Invalid update' });
    }

    // Дедупликация
    if (!markProcessed(update.update_id)) {
      console.log(`Duplicate update_id: ${update.update_id}`);
      return res.json({ ok: true, duplicate: true });
    }

    logUpdate(update);

    try {
      // Подключение/отключение business-аккаунта
      if (update.business_connection) {
        const conn = update.business_connection;
        console.log(`Business connection: ${conn.id} enabled=${conn.is_enabled}`);
        saveConnection(conn);
        return res.json({ ok: true, type: 'business_connection' });
      }

      if (update.business_message) {
        return await handleBusinessMessage(update, res);
      }

      console.log('Unknown update type:', Object.keys(update));
      return res.json({ ok: true, type: 'unknown' });
    } catch (err) {
      console.error('Error processing update:', err);
      // Снимаем пометку дедупликации — Telegram повторит доставку после 500,
      // и повтор не должен быть отброшен как дубликат
      unmarkProcessed(update.update_id);
      return res.status(500).json({ error: err.message });
    }
  });

  async function handleBusinessMessage(update, res) {
    const msg = update.business_message;
    const sender = msg.from;
    const businessConnectionId = msg.business_connection_id;
    const businessChatId = msg.chat.id;
    const text = msg.text || msg.caption || '';
    const persona = loadPersona();

    // Сообщение от ВЛАДЕЛЬЦА (он ответил сам)
    if (String(sender.id) === OWNER_CHAT_ID) {
      console.log(`⏭️  Сообщение от владельца в чат ${businessChatId}`);

      // Сохраняем ответ владельца в историю — иначе секретарь не будет знать,
      // что владелец уже что-то сказал, и может ему противоречить
      const ownerMapping = findMappingByChat(businessConnectionId, businessChatId);
      if (ownerMapping && text) {
        appendConversationHistory(ownerMapping.mappingId, 'owner', text);
      }

      const cancelled = cancelPending(businessChatId, 'owner replied');
      if (cancelled) {
        console.log(`✓ Владелец ответил сам в чат ${businessChatId} — pending отменён`);
        await notifyOwnerText(`✓ Ты ответил сам — отложенный ответ ${persona.secretary_name} отменён`);
      }

      logUpdate({ ...update, _meta: { ignored_owner_outgoing: true, pending_cancelled: cancelled } });
      return res.json({ ok: true, type: 'business_message', ignored: 'owner_outgoing', pending_cancelled: cancelled });
    }

    const envelope = telegramBusiness.toEnvelope(msg);

    // Голосовое + настроенный STT → транскрибируем и обрабатываем как текст
    if (!envelope.text && (msg.voice || msg.audio || msg.video_note) && isSttConfigured()) {
      const stt = await transcribeVoice(msg);
      if (stt.ok) {
        envelope.text = stt.text;
        envelope.attachments.push({ type: 'voice_transcribed' });
        console.log(`[STT] Голосовое транскрибировано: ${truncate(stt.text, 60)}`);
      } else {
        console.warn(`[STT] Транскрипция не удалась (${stt.error}) — эскалация владельцу`);
      }
    }

    console.log(`Business message from ${sender.id} (@${sender.username}): ${envelope.text.slice(0, 50) || '[non-text]'}...`);

    // Контакты (исторический стейт) + персона (identity-слой)
    updateContact(sender, businessConnectionId);
    const person = resolvePerson({
      platform: envelope.platform,
      platformUserId: envelope.identity.platform_user_id,
      displayName: envelope.identity.display_name,
      username: envelope.identity.username
    });

    const mapping = getOrCreateMapping(businessConnectionId, businessChatId, sender);
    console.log(`Mapping: ${mapping.mappingId} (new=${mapping.isNew}), person: ${person.id} (policy=${person.policy})`);

    const senderInfo = {
      sender_id: String(sender.id),
      sender_username: sender.username,
      sender_name: envelope.identity.display_name
    };
    const senderDisplay = usernameDisplay(envelope.identity);

    // Политика ignore: не отвечаем и не уведомляем
    if (person.policy === 'ignore') {
      console.log(`[Policy] ignore: person ${person.id}, no reply, no notify`);
      return res.json({ ok: true, type: 'business_message', person_id: person.id, policy: 'ignore' });
    }

    // Сохраняем входящее в историю (текст или маркер вложения)
    const historyText = envelope.text
      || `[вложение: ${envelope.attachments.map(a => a.type).join(', ') || 'неизвестно'}]`;
    appendConversationHistory(mapping.mappingId, 'client', historyText);

    // Политика escalate: без LLM, сразу владельцу
    if (person.policy === 'escalate') {
      console.log(`[Policy] escalate: person ${person.id} → owner`);
      const notify = await notifyOwnerText(
        `🔴 [Эскалация → ${mapping.mappingId}] ${senderDisplay} (${senderInfo.sender_name}):\n` +
        `«${truncate(historyText, 300)}»\n\nАвтоответ отключён политикой контакта — ответь сам.`,
        { buttons: escalationButtons(mapping.mappingId, person.id) }
      );
      return res.json({
        ok: true, type: 'business_message', person_id: person.id,
        policy: 'escalate', owner_notified: notify.ok
      });
    }

    // Не-текстовое сообщение: автоответ невозможен осмысленно — эскалация
    if (!envelope.text) {
      console.log(`[Policy] non-text message from ${person.id} → escalate to owner`);
      const notify = await notifyOwnerText(
        `📎 [Не-текст → ${mapping.mappingId}] ${senderDisplay} (${senderInfo.sender_name}): ${historyText}\n\n` +
        `Автоответ на вложения не поддерживается — ответь сам.`,
        { buttons: [[{ text: '✍️ Свой ответ', callback_data: `rep:${mapping.mappingId}` }]] }
      );
      return res.json({
        ok: true, type: 'business_message', person_id: person.id,
        non_text: true, owner_notified: notify.ok
      });
    }

    const settings = getSettings();

    // Режим off: «я свободен» — только уведомление, без автоответа
    if (settings.mode === 'off') {
      const notify = await notifyOwnerText(
        `📨 [${mapping.mappingId}] ${senderDisplay} (${senderInfo.sender_name}):\n` +
        `«${truncate(envelope.text, 300)}»\n\n⏸ Автоответ выключен (/on — включить)`,
        { buttons: escalationButtons(mapping.mappingId, person.id) }
      );
      return res.json({
        ok: true, type: 'business_message', mapping_id: mapping.mappingId,
        person_id: person.id, mode: 'off', owner_notified: notify.ok
      });
    }

    // Политика auto: отложенный ответ (vacation — короткая задержка)
    const prevTask = getPendingTask(businessChatId);
    const pendingInfo = createPending(mapping, senderInfo, envelope.text, {
      envelope,
      personId: person.id,
      delayMs: settings.mode === 'vacation' ? VACATION_DELAY_SECONDS * 1000 : undefined,
      notifyMessageId: prevTask?.notifyMessageId
    });

    const notifyText =
      `📨 [Pending → ${mapping.mappingId}] ${senderDisplay} (${senderInfo.sender_name}):\n` +
      `«${truncate(envelope.text, 300)}»\n\n` +
      `⏱ Отвечу через ${delayLabel(pendingInfo.delayMinutes)} если ты не ответишь сам` +
      (prevTask ? '\n(серия сообщений — таймер перезапущен)' : '');
    const buttons = pendingButtons(businessChatId, mapping.mappingId, person.id);

    // Debounce: серия сообщений от одного человека — одно обновляемое уведомление
    let notifyResult;
    if (prevTask?.notifyMessageId) {
      notifyResult = await editOwnerMessage(prevTask.notifyMessageId, notifyText, { buttons });
    } else {
      notifyResult = await notifyOwnerText(notifyText, { buttons });
      if (notifyResult.ok && notifyResult.result?.message_id) {
        setPendingNotifyMessageId(businessChatId, notifyResult.result.message_id);
      }
    }

    console.log(`Pending created: ${pendingInfo.mappingId}, delay ${pendingInfo.delayMinutes} min, notify ok=${notifyResult.ok}`);

    return res.json({
      ok: true,
      type: 'business_message',
      mapping_id: mapping.mappingId,
      person_id: person.id,
      pending: true,
      delay_minutes: pendingInfo.delayMinutes,
      owner_notified: notifyResult.ok
    });
  }

  /**
   * API: ручной ответ клиенту
   * POST /api/reply { mapping_id, text }
   */
  /**
   * ВКонтакте: Callback API сообщества (этап 4).
   * 503, пока не заданы VK_GROUP_TOKEN и VK_CONFIRMATION_CODE.
   */
  app.post('/vk/callback', vkCallbackHandler);

  app.post('/api/reply', async (req, res) => {
    const { mapping_id, text } = req.body;

    if (!mapping_id || !text) {
      return res.status(400).json({ error: 'mapping_id and text required' });
    }

    console.log(`Replying to ${mapping_id}: ${truncate(text, 50)}`);
    const result = await sendManualReply(mapping_id, text);

    if (result.ok) return res.json(result);
    const status = result.error?.startsWith('Mapping not found') ? 404 : 500;
    return res.status(status).json(result);
  });

  /**
   * API: режим работы (auto/off/vacation + draft) — то же, что команды боту
   */
  app.get('/api/mode', (req, res) => {
    res.json(getSettings());
  });

  /**
   * API: контакты (исторический стейт)
   */
  app.get('/api/contacts', (req, res) => {
    const contacts = getContacts();
    res.json({ count: Object.keys(contacts).length, contacts });
  });

  /**
   * API: персоны (identity-слой) и политики
   */
  app.get('/api/persons', (req, res) => {
    const persons = getPersons();
    res.json({ count: Object.keys(persons).length, persons });
  });

  app.post('/api/persons/:id/policy', (req, res) => {
    const { policy } = req.body || {};
    const result = setPersonPolicy(req.params.id, policy);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });

  /**
   * API: слияние персон — только по явному решению владельца
   * POST /api/persons/:id/merge { source_id }
   */
  app.post('/api/persons/:id/merge', (req, res) => {
    const { source_id } = req.body || {};
    if (!source_id) return res.status(400).json({ ok: false, error: 'source_id required' });
    const result = mergePersons(req.params.id, source_id);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });

  /**
   * API: карта разговоров
   */
  app.get('/api/conversations', (req, res) => {
    const conversations = getConversations();
    res.json({ count: Object.keys(conversations).length, conversations });
  });

  /**
   * API: очередь отложенных ответов
   */
  app.get('/api/pending', (req, res) => {
    const pending = getAllPending();
    res.json({
      count: Object.keys(pending).length,
      current_delay_minutes: getDelayMinutes(),
      pending
    });
  });

  app.delete('/api/pending/:chatId', (req, res) => {
    const { chatId } = req.params;
    const cancelled = cancelPending(chatId, 'manual cancel via API');
    if (cancelled) {
      res.json({ ok: true, message: `Pending for chat ${chatId} cancelled` });
    } else {
      res.status(404).json({ ok: false, error: `No pending found for chat ${chatId}` });
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}
