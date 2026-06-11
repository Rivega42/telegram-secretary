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
import { sendBusinessReply, notifyOwnerText } from './forward.js';
import { respond as brainRespond } from './core/brain.js';
import { loadPersona } from './core/persona.js';
import { resolvePerson, getPerson, getPersons, setPersonPolicy, mergePersons } from './core/identity.js';
import { createEnvelope } from './core/envelope.js';
import * as telegramBusiness from './connectors/telegram/business.js';
import {
  setExecuteCallback,
  createPending,
  cancelPending,
  getAllPending,
  getDelayMinutes
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

    const replyResult = await telegramBusiness.reply(envelope, brainResult.text);
    console.log(`[Execute] Business reply result: ok=${replyResult.ok}`);

    // В историю пишется только то, что реально дошло до клиента,
    // иначе контекст разойдётся с тем, что клиент видел
    if (replyResult.ok) {
      appendConversationHistory(task.mappingId, 'vika', brainResult.text);
    }

    logOutgoing(task.mappingId, brainResult.text, replyResult.ok);

    // Копия владельцу
    const usernameDisplay = envelope.identity.username
      ? `@${envelope.identity.username}`
      : '(no username)';
    await notifyOwnerText(
      `💼 [${persona.secretary_name} → ${usernameDisplay}]\n(⏱ отложенный ответ)\n` +
      `Получено: «${task.originalText.slice(0, 200)}${task.originalText.length > 200 ? '...' : ''}»\n` +
      `Ответила: «${brainResult.text.slice(0, 300)}${brainResult.text.length > 300 ? '...' : ''}»` +
      (replyResult.ok ? '' : '\n⚠️ ОТПРАВКА НЕ УДАЛАСЬ')
    );
  } catch (err) {
    console.error('[Execute] Error executing brain response:', err);
  }
}

export function createApp() {
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
    const usernameDisplay = senderInfo.sender_username ? `@${senderInfo.sender_username}` : '(no username)';

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
        `🔴 [Эскалация → ${mapping.mappingId}] ${usernameDisplay} (${senderInfo.sender_name}):\n` +
        `«${historyText.slice(0, 300)}»\n\nАвтоответ отключён политикой контакта — ответь сам.`
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
        `📎 [Не-текст → ${mapping.mappingId}] ${usernameDisplay} (${senderInfo.sender_name}): ${historyText}\n\n` +
        `Автоответ на вложения не поддерживается — ответь сам.`
      );
      return res.json({
        ok: true, type: 'business_message', person_id: person.id,
        non_text: true, owner_notified: notify.ok
      });
    }

    // Политика auto: отложенный ответ
    const delayMinutes = getDelayMinutes();
    const pendingInfo = createPending(mapping, senderInfo, envelope.text, {
      envelope,
      personId: person.id
    });

    const notifyResult = await notifyOwnerText(
      `📨 [Pending → ${mapping.mappingId}] ${usernameDisplay} (${senderInfo.sender_name}):\n` +
      `«${envelope.text.slice(0, 300)}${envelope.text.length > 300 ? '...' : ''}»\n\n` +
      `⏱ Отвечу через ${delayMinutes} мин если ты не ответишь сам`
    );

    console.log(`Pending created: ${pendingInfo.mappingId}, delay ${delayMinutes} min, notify ok=${notifyResult.ok}`);

    return res.json({
      ok: true,
      type: 'business_message',
      mapping_id: mapping.mappingId,
      person_id: person.id,
      pending: true,
      delay_minutes: delayMinutes,
      owner_notified: notifyResult.ok
    });
  }

  /**
   * API: ручной ответ клиенту
   * POST /api/reply { mapping_id, text }
   */
  app.post('/api/reply', async (req, res) => {
    const { mapping_id, text } = req.body;

    if (!mapping_id || !text) {
      return res.status(400).json({ error: 'mapping_id and text required' });
    }

    const mapping = getMapping(mapping_id);
    if (!mapping) {
      return res.status(404).json({ error: `Mapping not found: ${mapping_id}` });
    }

    console.log(`Replying to ${mapping_id}: ${text.slice(0, 50)}...`);
    cancelPending(mapping.business_chat_id, 'manual reply via API');

    const result = await sendBusinessReply(
      mapping.business_connection_id,
      mapping.business_chat_id,
      text
    );

    if (result.ok) {
      appendConversationHistory(mapping_id, 'vika', text);
    }
    logOutgoing(mapping_id, text, result.ok);

    if (result.ok) {
      return res.json({ ok: true, message_id: result.result?.message_id, sent_to: mapping.sender_name });
    }
    return res.status(500).json({ ok: false, error: result.error || result.description });
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

// Scheduler исполняет ответы через Brain
setExecuteCallback(executeBrainResponse);
