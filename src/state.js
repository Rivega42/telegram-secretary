/**
 * state.js — стейт secretary-proxy поверх SQLite (core/db.js)
 *
 * Хранит: connections, contacts, conversations (маппинги), history (диалоги),
 * через identity.js — persons. Логи событий остаются JSONL (append-only,
 * с ротацией). Публичный API не менялся при переходе с JSON-файлов (#26);
 * старые JSON-файлы импортируются автоматически (см. core/db.js).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDb } from './core/db.js';
import { currentTenantId } from './core/context.js';

const STATE_DIR = process.env.STATE_DIR || './state';

// Создаём директорию если нет (для логов)
if (!fs.existsSync(STATE_DIR)) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

const PROCESSED_TTL_MS = parseInt(process.env.PROCESSED_TTL_MS || String(24 * 60 * 60 * 1000), 10);

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
 * Проверить и пометить событие обработанным (дедупликация). Персистентно в SQLite —
 * переживает рестарт, поэтому повторная доставка вебхука после деплоя не вызовет
 * дубль ответа. key — строка с префиксом платформы (tg:/vk:/wa:).
 * Возвращает true, если событие новое; false — если уже обработано.
 */
export function markProcessed(key) {
  const info = getDb()
    .prepare('INSERT OR IGNORE INTO processed (key, ts) VALUES (?, ?)')
    .run(String(key), Date.now());
  return info.changes === 1;
}

/**
 * Снять пометку «обработан» — при ошибке обработки, чтобы повторная доставка
 * не была отброшена как дубликат.
 */
export function unmarkProcessed(key) {
  getDb().prepare('DELETE FROM processed WHERE key = ?').run(String(key));
}

/**
 * Очистить старые записи дедупликации (вызывается при старте и раз в сутки).
 */
export function pruneProcessed(ttlMs = PROCESSED_TTL_MS) {
  try {
    const info = getDb().prepare('DELETE FROM processed WHERE ts < ?').run(Date.now() - ttlMs);
    if (info.changes) console.log(`[State] Очищено записей дедупликации: ${info.changes}`);
  } catch (err) {
    console.error('[State] Ошибка очистки processed:', err.message);
  }
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
  const rows = getDb().prepare('SELECT id, data FROM connections WHERE tenant_id = ?').all(currentTenantId());
  return Object.fromEntries(rows.map(r => [r.id, JSON.parse(r.data)]));
}

export function saveConnection(connection) {
  const data = {
    id: connection.id,
    user_chat_id: connection.user_chat_id,
    user: connection.user,
    date: connection.date,
    can_reply: connection.can_reply,
    is_enabled: connection.is_enabled,
    updated_at: new Date().toISOString()
  };
  getDb().prepare('INSERT OR REPLACE INTO connections (id, tenant_id, data) VALUES (?, ?, ?)')
    .run(String(connection.id), currentTenantId(), JSON.stringify(data));
  appendLog({ type: 'connection', connection_id: connection.id, action: 'saved' });
  return data;
}

/**
 * === CONTACTS === (telegram-метаданные; идентичность/политики — в identity.js)
 */
export function getContacts() {
  const rows = getDb().prepare('SELECT id, data FROM contacts WHERE tenant_id = ?').all(currentTenantId());
  return Object.fromEntries(rows.map(r => [r.id, JSON.parse(r.data)]));
}

export function updateContact(user, businessConnectionId) {
  const db = getDb();
  const id = String(user.id);
  const tenant = currentTenantId();
  const row = db.prepare('SELECT data FROM contacts WHERE tenant_id = ? AND id = ?').get(tenant, id);
  const contact = row ? JSON.parse(row.data) : {
    id: user.id,
    username: user.username || null,
    first_name: user.first_name || '',
    last_name: user.last_name || '',
    first_seen: new Date().toISOString(),
    message_count: 0,
    business_connections: []
  };

  contact.last_seen = new Date().toISOString();
  contact.message_count = (contact.message_count || 0) + 1;
  contact.username = user.username || contact.username;
  contact.first_name = user.first_name || contact.first_name;
  contact.last_name = user.last_name || contact.last_name;
  if (businessConnectionId && !contact.business_connections.includes(businessConnectionId)) {
    contact.business_connections.push(businessConnectionId);
  }

  db.prepare('INSERT OR REPLACE INTO contacts (tenant_id, id, data) VALUES (?, ?, ?)')
    .run(tenant, id, JSON.stringify(contact));
  return contact;
}

/**
 * === CONVERSATIONS ===
 * Маппинг: mapping_id → { business_connection_id, business_chat_id, sender_* }
 */
export function getConversations() {
  const rows = getDb().prepare('SELECT mapping_id, data FROM conversations WHERE tenant_id = ?').all(currentTenantId());
  return Object.fromEntries(rows.map(r => [r.mapping_id, JSON.parse(r.data)]));
}

export function getOrCreateMapping(businessConnectionId, businessChatId, sender) {
  const db = getDb();
  const tenant = currentTenantId();
  const existing = db.prepare(
    'SELECT mapping_id, data FROM conversations WHERE tenant_id = ? AND business_connection_id = ? AND business_chat_id = ?'
  ).get(tenant, String(businessConnectionId), String(businessChatId));

  if (existing) {
    const data = JSON.parse(existing.data);
    data.last_message_at = new Date().toISOString();
    db.prepare('UPDATE conversations SET data = ? WHERE mapping_id = ?')
      .run(JSON.stringify(data), existing.mapping_id);
    return { mappingId: existing.mapping_id, isNew: false, ...data };
  }

  const mappingId = generateMappingId();
  const data = {
    business_connection_id: businessConnectionId,
    business_chat_id: businessChatId,
    sender_id: sender.id,
    sender_username: sender.username || null,
    sender_name: [sender.first_name, sender.last_name].filter(Boolean).join(' '),
    created_at: new Date().toISOString(),
    last_message_at: new Date().toISOString()
  };
  db.prepare(
    'INSERT INTO conversations (mapping_id, tenant_id, business_connection_id, business_chat_id, data) VALUES (?, ?, ?, ?, ?)'
  ).run(mappingId, tenant, String(businessConnectionId), String(businessChatId), JSON.stringify(data));
  appendLog({ type: 'mapping', mapping_id: mappingId, action: 'created', chat_id: businessChatId });

  return { mappingId, isNew: true, ...data };
}

export function getMapping(mappingId) {
  const row = getDb().prepare('SELECT data FROM conversations WHERE tenant_id = ? AND mapping_id = ?').get(currentTenantId(), mappingId);
  return row ? JSON.parse(row.data) : null;
}

/**
 * Найти существующий маппинг по business-чату (без создания нового)
 */
export function findMappingByChat(businessConnectionId, businessChatId) {
  const row = getDb().prepare(
    'SELECT mapping_id, data FROM conversations WHERE tenant_id = ? AND business_connection_id = ? AND business_chat_id = ?'
  ).get(currentTenantId(), String(businessConnectionId), String(businessChatId));
  return row ? { mappingId: row.mapping_id, ...JSON.parse(row.data) } : null;
}

/**
 * === LOGGING === (JSONL с ротацией — см. rotateLogs)
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
 * История диалога per thread_id (mapping_id / lead-<id> / vk-<peer>).
 * Возвращается ХРОНОЛОГИЧЕСКИ (старые → новые) — инвариант проекта.
 */
export function getConversationHistory(threadId, limit = 10) {
  const rows = getDb().prepare(
    'SELECT ts, role, text FROM history WHERE tenant_id = ? AND thread_id = ? ORDER BY id DESC LIMIT ?'
  ).all(currentTenantId(), String(threadId), limit);
  return rows.reverse().map(r => ({ ts: r.ts, from: r.role, text: r.text }));
}

export function appendConversationHistory(threadId, from, text) {
  getDb().prepare('INSERT INTO history (tenant_id, thread_id, ts, role, text) VALUES (?, ?, ?, ?, ?)')
    .run(currentTenantId(), String(threadId), new Date().toISOString(), from, text);
}
