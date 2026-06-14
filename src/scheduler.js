/**
 * scheduler.js — Управление отложенными ответами Вики
 * 
 * pendingTasks: Map<businessChatId, { mappingId, businessConnectionId, senderInfo, originalText, scheduledAt, timeoutHandle }>
 * 
 * Правила:
 * - 08:00-18:00 МСК → 2 минуты задержки (рабочий день)
 * - 18:00-08:00 МСК → 3 минуты задержки (вечер/ночь)
 * - Если владелец ответил сам в этот чат → pending отменяется
 */

import { getDb } from './core/db.js';

// In-memory Map: businessChatId → pending task (ожидают таймера)
const pendingTasks = new Map();

// Задачи в процессе генерации ответа (между стартом LLM и отправкой).
// Нужны, чтобы ответ владельца во время генерации мог пометить задачу отменённой
// и исполнитель НЕ отправил дубль (см. cancelPending + executeBrainResponse).
const executingTasks = new Map();

// Callback для выполнения ответа (устанавливается из server.js)
let executeResponseCallback = null;

/**
 * Установить callback для выполнения ответа
 */
export function setExecuteCallback(callback) {
  executeResponseCallback = callback;
}

/**
 * Получить задержку в минутах на основе времени МСК
 */
export function getDelayMinutes() {
  const moscowTime = new Date().toLocaleString('en-US', {
    timeZone: 'Europe/Moscow',
    hour: 'numeric',
    hour12: false
  });
  const h = parseInt(moscowTime);
  // 08:00-18:00 → 2 мин (рабочий день), иначе 3 мин
  return (h >= 8 && h < 18) ? 2 : 3;
}

/**
 * Сохранить pending в SQLite (persistence; имя сохранено для совместимости API)
 */
function savePendingToFile() {
  try {
    const db = getDb();
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM pending').run();
      const ins = db.prepare('INSERT INTO pending (chat_id, data) VALUES (?, ?)');
      for (const [chatId, task] of pendingTasks.entries()) {
        const { timeoutHandle, ...data } = task;
        ins.run(String(chatId), JSON.stringify(data));
      }
    });
    tx();
  } catch (err) {
    console.error('[Scheduler] Error saving pending:', err.message);
  }
}

/**
 * Загрузить pending из SQLite и восстановить таймеры
 * (старый pending.json импортируется в БД автоматически — см. core/db.js)
 */
export function loadPendingFromFile() {
  try {
    const rows = getDb().prepare('SELECT chat_id, data FROM pending').all();
    if (!rows.length) {
      console.log('[Scheduler] No pending tasks, starting fresh');
      return;
    }

    const data = Object.fromEntries(rows.map(r => [r.chat_id, JSON.parse(r.data)]));
    const now = Date.now();
    
    for (const [chatId, task] of Object.entries(data)) {
      const scheduledTime = new Date(task.scheduledAt).getTime() + task.delayMs;
      const remainingMs = scheduledTime - now;
      
      if (remainingMs <= 0) {
        // Истекло — выполнить немедленно
        console.log(`[Scheduler] Pending for chat ${chatId} expired, executing now`);
        if (executeResponseCallback) {
          setImmediate(() => executeResponseCallback(task));
        }
      } else {
        // Восстановить таймер
        console.log(`[Scheduler] Restoring pending for chat ${chatId}, ${Math.round(remainingMs/1000)}s remaining`);
        const timeoutHandle = setTimeout(() => {
          executePending(chatId);
        }, remainingMs);
        // Таймер не должен держать процесс живым сам по себе (его держит HTTP-сервер)
        timeoutHandle.unref();
        
        pendingTasks.set(chatId, {
          ...task,
          timeoutHandle
        });
      }
    }
    
    console.log(`[Scheduler] Loaded ${pendingTasks.size} pending tasks`);

  } catch (err) {
    console.error('[Scheduler] Error loading pending:', err.message);
  }
}

/**
 * Создать pending task.
 * extra: {
 *   envelope, personId      — конверт сообщения и ID персоны (этап 1)
 *   delayMs                 — переопределение задержки (режим vacation)
 *   notifyMessageId         — id уведомления владельцу (debounce-редактирование)
 * }
 */
export function createPending(mapping, senderInfo, originalText, extra = {}) {
  const chatId = String(mapping.business_chat_id);

  // Если уже есть pending для этого чата — отменить старый
  if (pendingTasks.has(chatId)) {
    console.log(`[Scheduler] Replacing existing pending for chat ${chatId}`);
    cancelPending(chatId, 'replaced by new message');
  }

  const delayMs = extra.delayMs ?? getDelayMinutes() * 60 * 1000;
  const delayMinutes = Math.round(delayMs / 60000 * 10) / 10;
  const scheduledAt = new Date().toISOString();

  const timeoutHandle = setTimeout(() => {
    executePending(chatId);
  }, delayMs);
  // Таймер не должен держать процесс живым сам по себе (его держит HTTP-сервер)
  timeoutHandle.unref();

  const task = {
    mappingId: mapping.mappingId,
    businessConnectionId: mapping.business_connection_id,
    businessChatId: mapping.business_chat_id,
    senderInfo,
    originalText,
    scheduledAt,
    delayMs,
    envelope: extra.envelope,
    personId: extra.personId,
    notifyMessageId: extra.notifyMessageId,
    timeoutHandle
  };
  
  pendingTasks.set(chatId, task);
  savePendingToFile();
  
  console.log(`[Scheduler] Created pending for chat ${chatId}, will execute in ${delayMinutes} min`);
  
  return {
    mappingId: mapping.mappingId,
    delayMinutes,
    scheduledAt
  };
}

/**
 * Отменить pending task (владелец ответил сам).
 * Если задача уже выполняется (идёт генерация ответа) — помечаем её отменённой,
 * чтобы исполнитель не отправил дубль поверх ответа владельца.
 */
export function cancelPending(chatId, reason = 'owner replied') {
  const chatIdStr = String(chatId);
  const task = pendingTasks.get(chatIdStr);

  if (task) {
    clearTimeout(task.timeoutHandle);
    pendingTasks.delete(chatIdStr);
    savePendingToFile();
    console.log(`[Scheduler] Cancelled pending for chat ${chatIdStr}: ${reason}`);
    return true;
  }

  // Задача уже в процессе генерации — помечаем, исполнитель прервёт отправку
  const executing = executingTasks.get(chatIdStr);
  if (executing) {
    executing.cancelled = true;
    console.log(`[Scheduler] Cancelled in-flight task for chat ${chatIdStr}: ${reason}`);
    return true;
  }

  return false;
}

/**
 * Выполнить pending task (таймаут истёк).
 * Переносим из очереди в executingTasks на время генерации, чтобы cancelPending
 * мог пометить задачу отменённой во время длинного вызова LLM.
 */
async function executePending(chatId) {
  const chatIdStr = String(chatId);
  const task = pendingTasks.get(chatIdStr);

  if (!task) {
    console.log(`[Scheduler] No pending found for chat ${chatIdStr} (already cancelled?)`);
    return;
  }

  pendingTasks.delete(chatIdStr);
  task.cancelled = false;
  executingTasks.set(chatIdStr, task);
  savePendingToFile();

  console.log(`[Scheduler] Executing pending for chat ${chatIdStr} (mapping ${task.mappingId})`);

  try {
    if (executeResponseCallback) {
      await executeResponseCallback(task);
    } else {
      console.error('[Scheduler] No execute callback set!');
    }
  } finally {
    executingTasks.delete(chatIdStr);
  }
}

/**
 * Выполнить pending немедленно (кнопка «Ответить сейчас» у владельца).
 */
export async function executePendingNow(chatId) {
  const chatIdStr = String(chatId);
  const task = pendingTasks.get(chatIdStr);
  if (!task) return false;
  clearTimeout(task.timeoutHandle);
  await executePending(chatIdStr);
  return true;
}

/**
 * Получить pending-задачу чата (для control plane).
 */
export function getPendingTask(chatId) {
  return pendingTasks.get(String(chatId)) || null;
}

/**
 * Обновить сохранённый id уведомления владельцу (debounce-редактирование).
 */
export function setPendingNotifyMessageId(chatId, messageId) {
  const task = pendingTasks.get(String(chatId));
  if (!task) return false;
  task.notifyMessageId = messageId;
  savePendingToFile();
  return true;
}

/**
 * Получить все pending tasks (для API)
 */
export function getAllPending() {
  const result = {};
  for (const [chatId, task] of pendingTasks.entries()) {
    const scheduledTime = new Date(task.scheduledAt).getTime() + task.delayMs;
    const remainingMs = scheduledTime - Date.now();
    
    result[chatId] = {
      mappingId: task.mappingId,
      senderInfo: task.senderInfo,
      originalText: task.originalText.slice(0, 100) + (task.originalText.length > 100 ? '...' : ''),
      scheduledAt: task.scheduledAt,
      willExecuteAt: new Date(scheduledTime).toISOString(),
      remainingSeconds: Math.max(0, Math.round(remainingMs / 1000))
    };
  }
  return result;
}

/**
 * Проверить есть ли pending для конкретного чата
 */
export function hasPending(chatId) {
  return pendingTasks.has(String(chatId));
}
