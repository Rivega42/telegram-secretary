/**
 * server.js — Secretary Proxy MVP
 * 
 * Express сервер для приёма Telegram Business webhook и проброса в OCPlatform.
 * 
 * Endpoints:
 * - POST /tg/business-webhook — приём апдейтов от Telegram
 * - POST /api/reply — ответ Вики клиенту
 * - GET /health — проверка работы
 * - GET /api/contacts — список известных контактов
 * - GET /api/conversations — карта разговоров
 * - GET /api/pending — список отложенных ответов
 * - DELETE /api/pending/:chatId — отменить pending вручную
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
import { notifyOwner, sendBusinessReply, checkBotToken, notifyOwnerCopy } from './forward.js';
import { generateVikaResponse } from './vika.js';
import {
  setExecuteCallback,
  loadPendingFromFile,
  createPending,
  cancelPending,
  getAllPending,
  getDelayMinutes
} from './scheduler.js';

const app = express();
const PORT = process.env.PORT || 18792;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const OWNER_CHAT_ID = String(process.env.OWNER_CHAT_ID || '');
const API_KEY = process.env.API_KEY;

// Middleware
app.use(express.json());

// Логирование запросов
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Авторизация админ-API: заголовок X-Api-Key или Authorization: Bearer
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
 * Уведомить Романа о pending сообщении
 */
async function notifyOwnerPending(mapping, senderInfo, messageText, delayMinutes) {
  const ONEINT_TOKEN = process.env.ONEINT_BOT_TOKEN;
  
  if (!ONEINT_TOKEN) {
    console.error('ONEINT_BOT_TOKEN not set');
    return { ok: false, error: 'Token not configured' };
  }
  
  const usernameDisplay = senderInfo.sender_username 
    ? `@${senderInfo.sender_username}` 
    : '(no username)';
  
  const text = `📨 [Pending → ${mapping.mappingId}] ${usernameDisplay} (${senderInfo.sender_name}):\n«${messageText.slice(0, 300)}${messageText.length > 300 ? '...' : ''}»\n\n⏱ Отвечу через ${delayMinutes} мин если ты не ответишь сам`;
  
  const url = `https://api.telegram.org/bot${ONEINT_TOKEN}/sendMessage`;
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: OWNER_CHAT_ID,
        text: text
      })
    });
    return await response.json();
  } catch (err) {
    console.error('Error notifying owner about pending:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Callback для scheduler — выполнить ответ Вики
 */
async function executeVikaResponse(task) {
  console.log(`[Execute] Running Vika response for mapping ${task.mappingId}`);
  
  try {
    // Получаем маппинг
    const mapping = getMapping(task.mappingId);
    if (!mapping) {
      console.error(`[Execute] Mapping ${task.mappingId} not found`);
      return;
    }
    
    // Получаем историю для контекста (25 последних сообщений)
    const history = getConversationHistory(task.mappingId, 25);
    
    // Вызываем Вику (LLM)
    console.log(`[Execute] Calling Vika LLM for mapping ${task.mappingId}...`);
    const vikaResult = await generateVikaResponse(task.senderInfo, task.originalText, history, false);
    
    console.log(`[Execute] Vika LLM result: ok=${vikaResult.ok}`);
    
    // Отправляем ответ Вики клиенту через business_connection
    const replyResult = await sendBusinessReply(
      task.businessConnectionId,
      task.businessChatId,
      vikaResult.response
    );
    
    console.log(`[Execute] Business reply result: ok=${replyResult.ok}`);

    // Сохраняем ответ Вики в историю только если он реально дошёл до клиента,
    // иначе контекст разойдётся с тем, что клиент видел на самом деле
    if (replyResult.ok) {
      appendConversationHistory(task.mappingId, 'vika', vikaResult.response);
    }

    // Логируем исходящее
    logOutgoing(task.mappingId, vikaResult.response, replyResult.ok);
    
    // Копия Роману
    const ONEINT_TOKEN = process.env.ONEINT_BOT_TOKEN;
    if (ONEINT_TOKEN) {
      const usernameDisplay = task.senderInfo.sender_username 
        ? `@${task.senderInfo.sender_username}` 
        : '(no username)';
      
      const copyText = `💼 [Vika → ${usernameDisplay}]\n(⏱ отложенный ответ)\nПолучено: «${task.originalText.slice(0, 200)}${task.originalText.length > 200 ? '...' : ''}»\nОтветила: «${vikaResult.response.slice(0, 300)}${vikaResult.response.length > 300 ? '...' : ''}»`;
      
      await fetch(`https://api.telegram.org/bot${ONEINT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: OWNER_CHAT_ID,
          text: copyText
        })
      });
    }
    
  } catch (err) {
    console.error(`[Execute] Error executing Vika response:`, err);
  }
}

// Устанавливаем callback для scheduler
setExecuteCallback(executeVikaResponse);

/**
 * Health check
 */
app.get('/health', async (req, res) => {
  const checks = {
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
    pending_count: Object.keys(getAllPending()).length
  };
  
  res.json(checks);
});

/**
 * Telegram Business Webhook
 * POST /tg/business-webhook
 */
app.post('/tg/business-webhook', async (req, res) => {
  // Проверка секрета (если настроен)
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
  
  // Логируем весь апдейт
  logUpdate(update);
  
  try {
    // Обработка business_connection (подключение/отключение)
    if (update.business_connection) {
      const conn = update.business_connection;
      console.log(`Business connection: ${conn.id} enabled=${conn.is_enabled}`);
      saveConnection(conn);
      return res.json({ ok: true, type: 'business_connection' });
    }
    
    // Обработка business_message
    if (update.business_message) {
      const msg = update.business_message;
      const sender = msg.from;
      const businessConnectionId = msg.business_connection_id;
      const businessChatId = msg.chat.id;
      const text = msg.text || '[non-text message]';

      // ЕСЛИ это сообщение от ВЛАДЕЛЬЦА (Роман пишет сам)
      // Проверяем и отменяем pending для этого чата
      if (String(sender.id) === OWNER_CHAT_ID) {
        console.log(`⏭️  Сообщение от владельца в чат ${businessChatId}`);

        // Сохраняем ответ владельца в историю — иначе Вика не будет знать,
        // что владелец уже что-то сказал, и может ему противоречить
        const ownerMapping = findMappingByChat(businessConnectionId, businessChatId);
        if (ownerMapping) {
          appendConversationHistory(ownerMapping.mappingId, 'owner', text);
        }

        // Отменяем pending для этого чата если есть
        const cancelled = cancelPending(businessChatId, 'owner replied');
        
        if (cancelled) {
          console.log(`✓ Роман ответил сам в чат ${businessChatId} — pending отменён`);
          
          // Уведомляем Романа что pending отменён
          const ONEINT_TOKEN = process.env.ONEINT_BOT_TOKEN;
          if (ONEINT_TOKEN) {
            await fetch(`https://api.telegram.org/bot${ONEINT_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: OWNER_CHAT_ID,
                text: `✓ Ты ответил сам — отложенный ответ Вики отменён`
              })
            });
          }
        }
        
        logUpdate({ ...update, _meta: { ignored_owner_outgoing: true, pending_cancelled: cancelled } });
        return res.json({ ok: true, type: 'business_message', ignored: 'owner_outgoing', pending_cancelled: cancelled });
      }

      console.log(`Business message from ${sender.id} (@${sender.username}): ${text.slice(0, 50)}...`);
      
      // Обновляем контакты
      updateContact(sender, businessConnectionId);
      
      // Получаем/создаём маппинг
      const mapping = getOrCreateMapping(businessConnectionId, businessChatId, sender);
      
      console.log(`Mapping: ${mapping.mappingId} (new=${mapping.isNew})`);
      
      const senderInfo = {
        sender_username: sender.username,
        sender_name: [sender.first_name, sender.last_name].filter(Boolean).join(' ')
      };
      
      // Сохраняем входящее сообщение в историю
      appendConversationHistory(mapping.mappingId, 'client', text);
      
      // === НОВАЯ ЛОГИКА: Отложенный ответ ===
      const delayMinutes = getDelayMinutes();
      
      // Создаём pending task
      const pendingInfo = createPending(mapping, senderInfo, text);
      
      // Уведомляем Романа о pending
      const notifyResult = await notifyOwnerPending(mapping, senderInfo, text, delayMinutes);
      
      console.log(`Pending created: ${pendingInfo.mappingId}, delay ${delayMinutes} min, notify ok=${notifyResult.ok}`);
      
      return res.json({ 
        ok: true, 
        type: 'business_message',
        mapping_id: mapping.mappingId,
        pending: true,
        delay_minutes: delayMinutes,
        owner_notified: notifyResult.ok
      });
    }
    
    // Неизвестный тип апдейта
    console.log(`Unknown update type:`, Object.keys(update));
    return res.json({ ok: true, type: 'unknown' });
    
  } catch (err) {
    console.error('Error processing update:', err);
    // Снимаем пометку дедупликации — Telegram повторит доставку после 500,
    // и повтор не должен быть отброшен как дубликат
    unmarkProcessed(update.update_id);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * API: Ответ Вики клиенту (ручной)
 * POST /api/reply
 * Body: { mapping_id: "abc123", text: "Ответ" }
 */
app.post('/api/reply', async (req, res) => {
  const { mapping_id, text } = req.body;
  
  if (!mapping_id || !text) {
    return res.status(400).json({ error: 'mapping_id and text required' });
  }
  
  // Получаем маппинг
  const mapping = getMapping(mapping_id);
  
  if (!mapping) {
    return res.status(404).json({ error: `Mapping not found: ${mapping_id}` });
  }
  
  console.log(`Replying to ${mapping_id}: ${text.slice(0, 50)}...`);
  
  // Отменяем pending для этого чата если есть
  cancelPending(mapping.business_chat_id, 'manual reply via API');
  
  // Отправляем через business_connection
  const result = await sendBusinessReply(
    mapping.business_connection_id,
    mapping.business_chat_id,
    text
  );
  
  // Логируем исходящее
  logOutgoing(mapping_id, text, result.ok);
  
  if (result.ok) {
    return res.json({ 
      ok: true, 
      message_id: result.result?.message_id,
      sent_to: mapping.sender_name
    });
  } else {
    return res.status(500).json({ 
      ok: false, 
      error: result.error || result.description 
    });
  }
});

/**
 * API: Список контактов (для дебага)
 * GET /api/contacts
 */
app.get('/api/contacts', (req, res) => {
  const contacts = getContacts();
  res.json({
    count: Object.keys(contacts).length,
    contacts
  });
});

/**
 * API: Карта разговоров (для дебага)
 * GET /api/conversations
 */
app.get('/api/conversations', (req, res) => {
  const conversations = getConversations();
  res.json({
    count: Object.keys(conversations).length,
    conversations
  });
});

/**
 * API: Список отложенных ответов
 * GET /api/pending
 */
app.get('/api/pending', (req, res) => {
  const pending = getAllPending();
  res.json({
    count: Object.keys(pending).length,
    current_delay_minutes: getDelayMinutes(),
    pending
  });
});

/**
 * API: Отменить pending вручную
 * DELETE /api/pending/:chatId
 */
app.delete('/api/pending/:chatId', (req, res) => {
  const { chatId } = req.params;
  const cancelled = cancelPending(chatId, 'manual cancel via API');
  
  if (cancelled) {
    res.json({ ok: true, message: `Pending for chat ${chatId} cancelled` });
  } else {
    res.status(404).json({ ok: false, error: `No pending found for chat ${chatId}` });
  }
});

/**
 * 404 handler
 */
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

/**
 * Start server
 */
// Загружаем pending tasks из файла при старте
loadPendingFromFile();

app.listen(PORT, () => {
  console.log(`\n🚀 Secretary Proxy started on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Webhook: POST http://localhost:${PORT}/tg/business-webhook`);
  console.log(`   Reply: POST http://localhost:${PORT}/api/reply`);
  console.log(`   Contacts: GET http://localhost:${PORT}/api/contacts`);
  console.log(`   Conversations: GET http://localhost:${PORT}/api/conversations`);
  console.log(`   Pending: GET http://localhost:${PORT}/api/pending`);
  console.log(`\n   DRY_RUN: ${process.env.DRY_RUN === 'true' ? 'YES' : 'NO'}`);
  console.log(`   State dir: ${process.env.STATE_DIR || './state'}`);
  console.log(`   Current delay: ${getDelayMinutes()} minutes (${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} MSK)`);
  if (!API_KEY) {
    console.warn('   ⚠️  API_KEY не задан — /api/* доступен без авторизации. Задай API_KEY в .env или закрой /api/* на уровне reverse-proxy.');
  }
  if (!WEBHOOK_SECRET) {
    console.warn('   ⚠️  WEBHOOK_SECRET не задан — webhook принимает запросы без проверки секрета.');
  }
  console.log('');
});
