/**
 * state.js — Управление JSON-состоянием secretary-proxy
 * 
 * Хранит:
 * - connections.json — активные business_connection_id
 * - contacts.json — известные собеседники
 * - conversations.json — маппинг mapping_id ↔ business_chat
 * - log-YYYY-MM-DD.jsonl — лог всех апдейтов
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const STATE_DIR = process.env.STATE_DIR || './state';

// Создаём директорию если нет
if (!fs.existsSync(STATE_DIR)) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

// Кеш для отслеживания дублей по update_id
const processedUpdates = new Set();
const MAX_PROCESSED_CACHE = 10000;

/**
 * Загрузить JSON файл
 */
function loadJson(filename, defaultValue = {}) {
  const filepath = path.join(STATE_DIR, filename);
  try {
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    }
  } catch (err) {
    console.error(`Error loading ${filename}:`, err.message);
  }
  return defaultValue;
}

/**
 * Сохранить JSON файл
 */
function saveJson(filename, data) {
  const filepath = path.join(STATE_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Записать строку в JSONL лог
 */
function appendLog(entry) {
  const date = new Date().toISOString().split('T')[0];
  const filepath = path.join(STATE_DIR, `log-${date}.jsonl`);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(filepath, line, 'utf-8');
}

/**
 * Проверить и пометить update_id как обработанный (дедупликация)
 */
export function markProcessed(updateId) {
  if (processedUpdates.has(updateId)) {
    return false; // уже обработан
  }
  processedUpdates.add(updateId);
  // Очистка старых если слишком много
  if (processedUpdates.size > MAX_PROCESSED_CACHE) {
    const toDelete = Array.from(processedUpdates).slice(0, 1000);
    toDelete.forEach(id => processedUpdates.delete(id));
  }
  return true;
}

/**
 * Снять пометку «обработан» — вызывается при ошибке обработки,
 * чтобы повторная доставка от Telegram не была отброшена как дубликат
 */
export function unmarkProcessed(updateId) {
  processedUpdates.delete(updateId);
}

/**
 * Генерировать короткий mapping_id (6 символов)
 */
export function generateMappingId() {
  return crypto.randomBytes(3).toString('hex');
}

/**
 * === CONNECTIONS ===
 */
export function getConnections() {
  return loadJson('connections.json', {});
}

export function saveConnection(connection) {
  const connections = getConnections();
  connections[connection.id] = {
    id: connection.id,
    user_chat_id: connection.user_chat_id,
    user: connection.user,
    date: connection.date,
    can_reply: connection.can_reply,
    is_enabled: connection.is_enabled,
    updated_at: new Date().toISOString()
  };
  saveJson('connections.json', connections);
  appendLog({ type: 'connection', connection_id: connection.id, action: 'saved' });
  return connections[connection.id];
}

/**
 * === CONTACTS ===
 */
export function getContacts() {
  return loadJson('contacts.json', {});
}

export function updateContact(user, businessConnectionId) {
  const contacts = getContacts();
  const id = String(user.id);
  
  if (!contacts[id]) {
    contacts[id] = {
      id: user.id,
      username: user.username || null,
      first_name: user.first_name || '',
      last_name: user.last_name || '',
      first_seen: new Date().toISOString(),
      last_seen: new Date().toISOString(),
      message_count: 0,
      business_connections: []
    };
  }
  
  contacts[id].last_seen = new Date().toISOString();
  contacts[id].message_count++;
  contacts[id].username = user.username || contacts[id].username;
  contacts[id].first_name = user.first_name || contacts[id].first_name;
  contacts[id].last_name = user.last_name || contacts[id].last_name;
  
  if (businessConnectionId && !contacts[id].business_connections.includes(businessConnectionId)) {
    contacts[id].business_connections.push(businessConnectionId);
  }
  
  saveJson('contacts.json', contacts);
  return contacts[id];
}

/**
 * === CONVERSATIONS ===
 * Маппинг: mapping_id → { business_connection_id, business_chat_id, sender_id }
 */
export function getConversations() {
  return loadJson('conversations.json', {});
}

export function getOrCreateMapping(businessConnectionId, businessChatId, sender) {
  const conversations = getConversations();
  
  // Ищем существующий маппинг для этой комбинации
  for (const [mappingId, data] of Object.entries(conversations)) {
    if (data.business_connection_id === businessConnectionId && 
        data.business_chat_id === businessChatId) {
      // Обновляем timestamp
      data.last_message_at = new Date().toISOString();
      saveJson('conversations.json', conversations);
      return { mappingId, isNew: false, ...data };
    }
  }
  
  // Создаём новый маппинг
  const mappingId = generateMappingId();
  conversations[mappingId] = {
    business_connection_id: businessConnectionId,
    business_chat_id: businessChatId,
    sender_id: sender.id,
    sender_username: sender.username || null,
    sender_name: [sender.first_name, sender.last_name].filter(Boolean).join(' '),
    created_at: new Date().toISOString(),
    last_message_at: new Date().toISOString()
  };
  
  saveJson('conversations.json', conversations);
  appendLog({ type: 'mapping', mapping_id: mappingId, action: 'created', chat_id: businessChatId });
  
  return { mappingId, isNew: true, ...conversations[mappingId] };
}

export function getMapping(mappingId) {
  const conversations = getConversations();
  return conversations[mappingId] || null;
}

/**
 * Найти существующий маппинг по business-чату (без создания нового)
 */
export function findMappingByChat(businessConnectionId, businessChatId) {
  const conversations = getConversations();
  for (const [mappingId, data] of Object.entries(conversations)) {
    if (data.business_connection_id === businessConnectionId &&
        data.business_chat_id === businessChatId) {
      return { mappingId, ...data };
    }
  }
  return null;
}

/**
 * === LOGGING ===
 */
export function logUpdate(update) {
  appendLog({ type: 'update', update_id: update.update_id, raw: update });
}

export function logOutgoing(mappingId, text, success) {
  appendLog({ type: 'outgoing', mapping_id: mappingId, text_preview: text.slice(0, 100), success });
}

/**
 * Ротация логов: log-YYYY-MM-DD.jsonl старше LOG_TTL_DAYS удаляются
 * (логи содержат тексты переписок — не храним вечно).
 * Вызывается при старте и раз в сутки (см. server.js).
 */
export function rotateLogs(ttlDays = parseInt(process.env.LOG_TTL_DAYS || '30', 10)) {
  if (ttlDays <= 0) return 0; // 0 или меньше — ротация выключена
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    for (const file of fs.readdirSync(STATE_DIR)) {
      const m = file.match(/^log-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m) continue;
      if (new Date(m[1]).getTime() < cutoff) {
        fs.unlinkSync(path.join(STATE_DIR, file));
        removed++;
      }
    }
    if (removed) console.log(`[State] Ротация логов: удалено файлов: ${removed} (старше ${ttlDays} дн.)`);
  } catch (err) {
    console.error('[State] Ошибка ротации логов:', err.message);
  }
  return removed;
}

/**
 * === CONVERSATION HISTORY ===
 * Хранит историю сообщений для каждого mapping_id в отдельном JSONL файле
 */
export function getConversationHistory(mappingId, limit = 10) {
  const filepath = path.join(STATE_DIR, 'conversations', `${mappingId}.jsonl`);
  try {
    if (!fs.existsSync(filepath)) {
      return [];
    }
    const lines = fs.readFileSync(filepath, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(line => JSON.parse(line));
  } catch (err) {
    console.error(`Error loading history for ${mappingId}:`, err.message);
    return [];
  }
}

export function appendConversationHistory(mappingId, from, text) {
  const convDir = path.join(STATE_DIR, 'conversations');
  if (!fs.existsSync(convDir)) {
    fs.mkdirSync(convDir, { recursive: true });
  }
  const filepath = path.join(convDir, `${mappingId}.jsonl`);
  const entry = { ts: new Date().toISOString(), from, text };
  fs.appendFileSync(filepath, JSON.stringify(entry) + '\n', 'utf-8');
}
