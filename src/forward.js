/**
 * forward.js — Функции отправки сообщений через Telegram API
 * 
 * Два направления:
 * 1. IN: business_message → уведомление Вике через @OneInt_bot
 * 2. OUT: ответ Вики → клиенту через @VikaBusiness_bot + business_connection_id
 */

const DRY_RUN = process.env.DRY_RUN === 'true';

/**
 * Базовый Telegram API вызов
 */
async function telegramApi(token, method, body = {}) {
  if (DRY_RUN) {
    console.log(`[DRY_RUN] Telegram API: ${method}`, JSON.stringify(body, null, 2));
    return { ok: true, result: { message_id: 999, dry_run: true } };
  }

  const url = `https://api.telegram.org/bot${token}/${method}`;
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    const data = await response.json();
    
    if (!data.ok) {
      console.error(`Telegram API error [${method}]:`, data.description);
    }
    
    return data;
  } catch (err) {
    console.error(`Telegram API fetch error [${method}]:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Отправить уведомление Вике о новом бизнес-сообщении
 * Через @OneInt_bot в личку OWNER_CHAT_ID
 */
export async function notifyOwner(mapping, senderInfo, messageText) {
  const ONEINT_TOKEN = process.env.ONEINT_BOT_TOKEN;
  const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
  
  if (!ONEINT_TOKEN) {
    console.error('ONEINT_BOT_TOKEN not set');
    return { ok: false, error: 'Token not configured' };
  }
  
  // Форматируем сообщение для Вики
  const usernameDisplay = senderInfo.sender_username 
    ? `@${senderInfo.sender_username}` 
    : '(no username)';
  
  const text = `📨 [Business → ${mapping.mappingId}] ${usernameDisplay} (${senderInfo.sender_name}):\n\n${messageText}\n\n↩️ Ответить: POST /api/reply { "mapping_id": "${mapping.mappingId}", "text": "..." }`;
  
  return telegramApi(ONEINT_TOKEN, 'sendMessage', {
    chat_id: OWNER_CHAT_ID,
    text: text,
    parse_mode: undefined // plain text для безопасности
  });
}

/**
 * Отправить ответ клиенту через business_connection
 * Через @VikaBusiness_bot
 */
export async function sendBusinessReply(businessConnectionId, chatId, text) {
  const BUSINESS_TOKEN = process.env.BUSINESS_BOT_TOKEN;
  
  if (!BUSINESS_TOKEN) {
    console.error('BUSINESS_BOT_TOKEN not set');
    return { ok: false, error: 'Token not configured' };
  }
  
  return telegramApi(BUSINESS_TOKEN, 'sendMessage', {
    business_connection_id: businessConnectionId,
    chat_id: chatId,
    text: text
  });
}

/**
 * Проверить токен бота (для healthcheck)
 */
export async function checkBotToken(token) {
  if (!token) return { ok: false, error: 'No token' };
  return telegramApi(token, 'getMe');
}

/**
 * Произвольное уведомление владельцу (control plane).
 * Уважает DRY_RUN через telegramApi.
 */
export async function notifyOwnerText(text) {
  const ONEINT_TOKEN = process.env.ONEINT_BOT_TOKEN;
  const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;

  if (!ONEINT_TOKEN) {
    console.error('ONEINT_BOT_TOKEN not set');
    return { ok: false, error: 'Token not configured' };
  }

  return telegramApi(ONEINT_TOKEN, 'sendMessage', {
    chat_id: OWNER_CHAT_ID,
    text,
    parse_mode: undefined
  });
}

/**
 * Отправить копию ответа Вики Роману
 * Формат: что получили, что ответили, mapping_id
 */
export async function notifyOwnerCopy(mapping, senderInfo, incomingText, vikaResponse) {
  const ONEINT_TOKEN = process.env.ONEINT_BOT_TOKEN;
  const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
  
  if (!ONEINT_TOKEN) {
    console.error('ONEINT_BOT_TOKEN not set');
    return { ok: false, error: 'Token not configured' };
  }
  
  const usernameDisplay = senderInfo.sender_username 
    ? `@${senderInfo.sender_username}` 
    : '(no username)';
  
  const text = `💼 [Vika → ${usernameDisplay}]\nПолучено: «${incomingText.slice(0, 200)}${incomingText.length > 200 ? '...' : ''}»\nОтветила: «${vikaResponse.slice(0, 300)}${vikaResponse.length > 300 ? '...' : ''}»\n\n↩️ Хочешь поправить — /correct ${mapping.mappingId} новый текст`;
  
  return telegramApi(ONEINT_TOKEN, 'sendMessage', {
    chat_id: OWNER_CHAT_ID,
    text: text,
    parse_mode: undefined
  });
}
