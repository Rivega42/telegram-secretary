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
 * Отправить ответ клиенту через business_connection
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
 * Произвольное уведомление владельцу (control plane).
 * Уважает DRY_RUN через telegramApi.
 *
 * opts.buttons — inline-клавиатура: массив строк кнопок [{text, callback_data}]
 */
export async function notifyOwnerText(text, opts = {}) {
  const ONEINT_TOKEN = process.env.ONEINT_BOT_TOKEN;
  const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;

  if (!ONEINT_TOKEN || !OWNER_CHAT_ID) {
    console.error('ONEINT_BOT_TOKEN / OWNER_CHAT_ID not set — owner notification skipped');
    return { ok: false, error: 'Owner notification not configured' };
  }

  return telegramApi(ONEINT_TOKEN, 'sendMessage', {
    chat_id: OWNER_CHAT_ID,
    text,
    parse_mode: undefined,
    ...(opts.buttons ? { reply_markup: { inline_keyboard: opts.buttons } } : {})
  });
}

/**
 * Отредактировать ранее отправленное уведомление владельцу
 * (debounce: серия сообщений от клиента → одно обновляемое уведомление).
 */
export async function editOwnerMessage(messageId, text, opts = {}) {
  const ONEINT_TOKEN = process.env.ONEINT_BOT_TOKEN;
  const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;

  if (!ONEINT_TOKEN || !OWNER_CHAT_ID || !messageId) {
    return { ok: false, error: 'Not configured or no message id' };
  }

  return telegramApi(ONEINT_TOKEN, 'editMessageText', {
    chat_id: OWNER_CHAT_ID,
    message_id: messageId,
    text,
    parse_mode: undefined,
    ...(opts.buttons ? { reply_markup: { inline_keyboard: opts.buttons } } : {})
  });
}

/**
 * Ответ на нажатие inline-кнопки (короткий toast владельцу).
 */
export async function answerCallback(callbackQueryId, text = '') {
  const ONEINT_TOKEN = process.env.ONEINT_BOT_TOKEN;
  if (!ONEINT_TOKEN) return { ok: false, error: 'Token not configured' };
  return telegramApi(ONEINT_TOKEN, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text.slice(0, 190)
  });
}

/**
 * Реалистичность ответа в business-чате: отметить прочитанным и показать
 * «печатает…» пропорционально длине ответа (с потолком). Уважает DRY_RUN.
 * Ошибки не критичны — best effort.
 */
export async function simulateTyping(businessConnectionId, chatId, messageId, textLength = 0) {
  if (process.env.TYPING_SIMULATION === 'false') return;
  const BUSINESS_TOKEN = process.env.BUSINESS_BOT_TOKEN;
  if (!BUSINESS_TOKEN) return;

  if (messageId) {
    await telegramApi(BUSINESS_TOKEN, 'readBusinessMessage', {
      business_connection_id: businessConnectionId,
      chat_id: chatId,
      message_id: messageId
    });
  }

  await telegramApi(BUSINESS_TOKEN, 'sendChatAction', {
    business_connection_id: businessConnectionId,
    chat_id: chatId,
    action: 'typing'
  });

  if (process.env.DRY_RUN === 'true') return;
  // ~200 знаков в минуту «печати», потолок 8 сек
  const ms = Math.min(8000, Math.max(1500, textLength * 50));
  await new Promise(r => setTimeout(r, ms));
}

/**
 * Ответ в группе/обсуждении канала от имени community-бота (он же бот уведомлений).
 * Уважает DRY_RUN через telegramApi.
 */
export async function sendGroupReply(chatId, replyToMessageId, text) {
  const ONEINT_TOKEN = process.env.ONEINT_BOT_TOKEN;
  if (!ONEINT_TOKEN) {
    return { ok: false, error: 'Token not configured' };
  }
  return telegramApi(ONEINT_TOKEN, 'sendMessage', {
    chat_id: chatId,
    text,
    ...(replyToMessageId ? { reply_to_message_id: replyToMessageId, allow_sending_without_reply: true } : {})
  });
}

/**
 * getMe community/control-бота (username для детекта упоминаний).
 */
export async function getControlBotInfo() {
  const ONEINT_TOKEN = process.env.ONEINT_BOT_TOKEN;
  if (!ONEINT_TOKEN) return { ok: false, error: 'Token not configured' };
  return telegramApi(ONEINT_TOKEN, 'getMe');
}

/**
 * Long-polling апдейтов control-бота (для connectors/telegram/control.js).
 * Не оборачивается в DRY_RUN: это ВХОДЯЩИЙ канал управления, а не отправка.
 */
export async function getControlUpdates(offset, timeoutSec = 25) {
  const ONEINT_TOKEN = process.env.ONEINT_BOT_TOKEN;
  if (!ONEINT_TOKEN) return { ok: false, error: 'Token not configured' };

  const url = `https://api.telegram.org/bot${ONEINT_TOKEN}/getUpdates`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout((timeoutSec + 10) * 1000),
      body: JSON.stringify({
        offset,
        timeout: timeoutSec,
        allowed_updates: ['message', 'callback_query']
      })
    });
    return await response.json();
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
