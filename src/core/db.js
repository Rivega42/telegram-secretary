/**
 * db.js — SQLite-хранилище стейта (better-sqlite3, WAL)
 *
 * Файл: STATE_DIR/secretary.db. Снимает гонки read-modify-write и O(n)-чтения
 * JSON-файлов (issue #26). Публичные API state.js/identity.js/scheduler.js
 * не изменились — поменялась только начинка.
 *
 * Миграция: при первом открытии БД существующие JSON-файлы старого формата
 * (connections, contacts, conversations + conversations/*.jsonl, persons,
 * pending) импортируются автоматически, исходники переименовываются в
 * *.migrated — данные пользователей не теряются (инвариант CLAUDE.md).
 *
 * Лёгкие конфиги (mode.json, drafts.json, content-plan.json, instances.json)
 * остаются файлами: их удобно править руками, нагрузки на них нет.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

let db = null;

function stateDir() {
  return process.env.STATE_DIR || './state';
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  mapping_id TEXT PRIMARY KEY,
  business_connection_id TEXT,
  business_chat_id TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_chat
  ON conversations (business_connection_id, business_chat_id);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_thread ON history (thread_id, id);
CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS person_identities (
  platform TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  PRIMARY KEY (platform, platform_user_id)
);
CREATE TABLE IF NOT EXISTS pending (
  chat_id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function getDb() {
  if (db) return db;

  const dir = stateDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(path.join(dir, 'secretary.db'));
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrateFromJson(db, dir);
  return db;
}

/** Для тестов: закрыть и забыть соединение (следующий getDb переоткроет). */
export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

function readJson(filepath) {
  try {
    if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch (err) {
    console.error(`[DB] Не удалось прочитать ${filepath} при миграции:`, err.message);
  }
  return null;
}

function markMigrated(filepath) {
  try {
    fs.renameSync(filepath, `${filepath}.migrated`);
  } catch { /* best effort */ }
}

/**
 * Одноразовый импорт стейта из JSON-файлов старого формата.
 */
function migrateFromJson(database, dir) {
  const done = database.prepare(`SELECT value FROM meta WHERE key = 'migrated_from_json'`).get();
  if (done) return;

  const tx = database.transaction(() => {
    let imported = [];

    const connections = readJson(path.join(dir, 'connections.json'));
    if (connections) {
      const ins = database.prepare('INSERT OR REPLACE INTO connections (id, data) VALUES (?, ?)');
      for (const [id, data] of Object.entries(connections)) ins.run(String(id), JSON.stringify(data));
      markMigrated(path.join(dir, 'connections.json'));
      imported.push(`connections:${Object.keys(connections).length}`);
    }

    const contacts = readJson(path.join(dir, 'contacts.json'));
    if (contacts) {
      const ins = database.prepare('INSERT OR REPLACE INTO contacts (id, data) VALUES (?, ?)');
      for (const [id, data] of Object.entries(contacts)) ins.run(String(id), JSON.stringify(data));
      markMigrated(path.join(dir, 'contacts.json'));
      imported.push(`contacts:${Object.keys(contacts).length}`);
    }

    const conversations = readJson(path.join(dir, 'conversations.json'));
    if (conversations) {
      const ins = database.prepare(
        'INSERT OR REPLACE INTO conversations (mapping_id, business_connection_id, business_chat_id, data) VALUES (?, ?, ?, ?)'
      );
      for (const [id, data] of Object.entries(conversations)) {
        ins.run(id, String(data.business_connection_id ?? ''), String(data.business_chat_id ?? ''), JSON.stringify(data));
      }
      markMigrated(path.join(dir, 'conversations.json'));
      imported.push(`conversations:${Object.keys(conversations).length}`);
    }

    // История диалогов: conversations/*.jsonl (порядок строк = хронология)
    const convDir = path.join(dir, 'conversations');
    if (fs.existsSync(convDir)) {
      const ins = database.prepare('INSERT INTO history (thread_id, ts, role, text) VALUES (?, ?, ?, ?)');
      let lines = 0;
      for (const file of fs.readdirSync(convDir)) {
        if (!file.endsWith('.jsonl')) continue;
        const threadId = file.replace(/\.jsonl$/, '');
        const content = fs.readFileSync(path.join(convDir, file), 'utf-8');
        for (const line of content.trim().split('\n').filter(Boolean)) {
          try {
            const entry = JSON.parse(line);
            ins.run(threadId, entry.ts || new Date().toISOString(), entry.from || 'client', entry.text || '');
            lines++;
          } catch { /* битая строка — пропускаем */ }
        }
        markMigrated(path.join(convDir, file));
      }
      if (lines) imported.push(`history:${lines}`);
    }

    const personsData = readJson(path.join(dir, 'persons.json'));
    if (personsData?.persons) {
      const insP = database.prepare('INSERT OR REPLACE INTO persons (id, data) VALUES (?, ?)');
      const insI = database.prepare('INSERT OR REPLACE INTO person_identities (platform, platform_user_id, person_id) VALUES (?, ?, ?)');
      for (const [id, person] of Object.entries(personsData.persons)) {
        insP.run(id, JSON.stringify(person));
        for (const [platform, pid] of Object.entries(person.identities || {})) {
          insI.run(platform, String(pid), id);
        }
      }
      database.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('persons_seq', ?)`)
        .run(String(personsData.seq || 0));
      markMigrated(path.join(dir, 'persons.json'));
      imported.push(`persons:${Object.keys(personsData.persons).length}`);
    }

    const pendingData = readJson(path.join(dir, 'pending.json'));
    if (pendingData) {
      const ins = database.prepare('INSERT OR REPLACE INTO pending (chat_id, data) VALUES (?, ?)');
      for (const [chatId, task] of Object.entries(pendingData)) ins.run(String(chatId), JSON.stringify(task));
      markMigrated(path.join(dir, 'pending.json'));
      imported.push(`pending:${Object.keys(pendingData).length}`);
    }

    database.prepare(`INSERT INTO meta (key, value) VALUES ('migrated_from_json', ?)`)
      .run(new Date().toISOString());

    if (imported.length) {
      console.log(`[DB] Миграция JSON → SQLite: ${imported.join(', ')} (исходники переименованы в *.migrated)`);
    }
  });
  tx();
}
