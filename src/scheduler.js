/**
 * scheduler.js — Управление отложенными ответами Вики
 * 
 * pendingTasks: Map<businessChatId, { mappingId, businessConnectionId, senderInfo, originalText, scheduledAt, timeoutHandle }>
 * 
 * Правила:
 * - 08:00-18:00 МСК → 5 минут задержки (рабочий день)
 * - 18:00-08:00 МСК → 3 минуты задержки (вечер/ночь)
 * - Если Роман ответил сам в этот чат → pending отменяется
 */

import fs from 'fs';
import path from 'path';

const STATE_DIR = process.env.STATE_DIR || './state';
const PENDING_FILE = path.join(STATE_DIR, 'pending.json');

// In-memory Map: businessChatId → pending task
const pendingTasks = new Map();

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
 * Сохранить pending в файл (persistence)
 */
function savePendingToFile() {
  const data = {};
  for (const [chatId, task] of pendingTasks.entries()) {
    data[chatId] = {
      mappingId: task.mappingId,
      businessConnectionId: task.businessConnectionId,
      businessChatId: task.businessChatId,
      senderInfo: task.senderInfo,
      originalText: task.originalText,
      scheduledAt: task.scheduledAt,
      delayMs: task.delayMs
    };
  }
  try {
    fs.writeFileSync(PENDING_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Scheduler] Error saving pending.json:', err.message);
  }
}

/**
 * Загрузить pending из файла и восстановить таймеры
 */
export function loadPendingFromFile() {
  try {
    if (!fs.existsSync(PENDING_FILE)) {
      console.log('[Scheduler] No pending.json found, starting fresh');
      return;
    }
    
    const data = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8'));
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
        
        pendingTasks.set(chatId, {
          ...task,
          timeoutHandle
        });
      }
    }
    
    console.log(`[Scheduler] Loaded ${pendingTasks.size} pending tasks`);
    
  } catch (err) {
    console.error('[Scheduler] Error loading pending.json:', err.message);
  }
}

/**
 * Создать pending task
 */
export function createPending(mapping, senderInfo, originalText) {
  const chatId = String(mapping.business_chat_id);
  
  // Если уже есть pending для этого чата — отменить старый
  if (pendingTasks.has(chatId)) {
    console.log(`[Scheduler] Replacing existing pending for chat ${chatId}`);
    cancelPending(chatId, 'replaced by new message');
  }
  
  const delayMinutes = getDelayMinutes();
  const delayMs = delayMinutes * 60 * 1000;
  const scheduledAt = new Date().toISOString();
  
  const timeoutHandle = setTimeout(() => {
    executePending(chatId);
  }, delayMs);
  
  const task = {
    mappingId: mapping.mappingId,
    businessConnectionId: mapping.business_connection_id,
    businessChatId: mapping.business_chat_id,
    senderInfo,
    originalText,
    scheduledAt,
    delayMs,
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
 * Отменить pending task (Роман ответил сам)
 */
export function cancelPending(chatId, reason = 'owner replied') {
  const chatIdStr = String(chatId);
  const task = pendingTasks.get(chatIdStr);
  
  if (!task) {
    return false;
  }
  
  clearTimeout(task.timeoutHandle);
  pendingTasks.delete(chatIdStr);
  savePendingToFile();
  
  console.log(`[Scheduler] Cancelled pending for chat ${chatIdStr}: ${reason}`);
  
  return true;
}

/**
 * Выполнить pending task (таймаут истёк)
 */
async function executePending(chatId) {
  const chatIdStr = String(chatId);
  const task = pendingTasks.get(chatIdStr);
  
  if (!task) {
    console.log(`[Scheduler] No pending found for chat ${chatIdStr} (already cancelled?)`);
    return;
  }
  
  pendingTasks.delete(chatIdStr);
  savePendingToFile();
  
  console.log(`[Scheduler] Executing pending for chat ${chatIdStr} (mapping ${task.mappingId})`);
  
  if (executeResponseCallback) {
    await executeResponseCallback(task);
  } else {
    console.error('[Scheduler] No execute callback set!');
  }
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
