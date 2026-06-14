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

// tenant_id присутствует во всех таблицах данных (SaaS, фаза S2). Там, где
// внешний id может повторяться между арендаторами (telegram user id, chat id,
// platform_user_id, person_id) — он входит в составной первичный ключ. `processed` —
// глобальная (ключи дедупа включают бот/группу), `tenants`/`tenant_channels`/`meta` — инфра.
//
// SCHEMA — только таблицы (и индексы без tenant_id). Индексы по tenant_id создаются
// в INDEXES ПОСЛЕ migrateTenantId, иначе на апгрейде старой БД (где колонки ещё нет)
// CREATE INDEX упадёт.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS conversations (
  mapping_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  business_connection_id TEXT,
  business_chat_id TEXT,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  thread_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS person_identities (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  platform TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, platform, platform_user_id)
);
CREATE TABLE IF NOT EXISTS pending (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  chat_id TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (tenant_id, chat_id)
);
CREATE TABLE IF NOT EXISTS processed (
  key TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_processed_ts ON processed (ts);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,          -- 'correction' | 'rating'
  surface TEXT,
  person_id TEXT,
  original TEXT,               -- черновик/ответ до правки
  note TEXT,                   -- указание владельца при «Переписать»
  corrected TEXT,              -- итоговый текст после правки
  rating INTEGER               -- +1 / -1 для лайк/дизлайк
);
CREATE TABLE IF NOT EXISTS leads (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  person_id TEXT NOT NULL,
  platform TEXT,
  source TEXT,              -- deep-link метка поста и т.п.
  display_name TEXT,
  first_message TEXT,
  status TEXT NOT NULL,     -- new | working | won | lost
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, person_id)
);
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT,
  owner_chat_id TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',  -- active | suspended
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tenant_channels (
  channel_key TEXT PRIMARY KEY,           -- tg:<bot_id> | vk:<group_id> | wa:<phone_number_id>
  tenant_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tenant_channels_tenant ON tenant_channels (tenant_id);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Индексы по tenant_id — после миграции (колонки уже гарантированно есть)
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_conversations_chat ON conversations (tenant_id, business_connection_id, business_chat_id);
CREATE INDEX IF NOT EXISTS idx_history_thread ON history (tenant_id, thread_id, id);
CREATE INDEX IF NOT EXISTS idx_persons_tenant ON persons (tenant_id);
CREATE INDEX IF NOT EXISTS idx_feedback_ts ON feedback (tenant_id, ts);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (tenant_id, status);
`;

export function getDb() {
  if (db) return db;

  const dir = stateDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(path.join(dir, 'secretary.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000'); // ждать до 5с при конкурентной блокировке вместо ошибки
  db.pragma('synchronous = NORMAL'); // безопасно в WAL, заметно быстрее
  db.exec(SCHEMA);
  migrateTenantId(db);
  db.exec(INDEXES);
  migrateFromJson(db, dir);
  return db;
}

function hasColumn(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}

/**
 * Апгрейд БД до-S2 (без tenant_id) до мультиарендной схемы. Существующие
 * строки получают tenant_id='default' — данные не теряются (инвариант CLAUDE.md).
 * Идемпотентно: при наличии tenant_id ничего не делает (свежая БД создаётся уже
 * по новой схеме).
 */
function migrateTenantId(db) {
  // Таблицы, где достаточно добавить колонку (PK не меняется)
  for (const t of ['connections', 'conversations', 'history', 'persons', 'feedback']) {
    if (!hasColumn(db, t, 'tenant_id')) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
    }
  }
  // Таблицы, где tenant_id входит в составной PK → пересоздание с переносом данных
  if (!hasColumn(db, 'contacts', 'tenant_id')) {
    db.exec(`
      ALTER TABLE contacts RENAME TO contacts_old;
      CREATE TABLE contacts (
        tenant_id TEXT NOT NULL DEFAULT 'default', id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (tenant_id, id)
      );
      INSERT INTO contacts (tenant_id, id, data) SELECT 'default', id, data FROM contacts_old;
      DROP TABLE contacts_old;
    `);
  }
  if (!hasColumn(db, 'person_identities', 'tenant_id')) {
    db.exec(`
      ALTER TABLE person_identities RENAME TO person_identities_old;
      CREATE TABLE person_identities (
        tenant_id TEXT NOT NULL DEFAULT 'default', platform TEXT NOT NULL,
        platform_user_id TEXT NOT NULL, person_id TEXT NOT NULL,
        PRIMARY KEY (tenant_id, platform, platform_user_id)
      );
      INSERT INTO person_identities (tenant_id, platform, platform_user_id, person_id)
        SELECT 'default', platform, platform_user_id, person_id FROM person_identities_old;
      DROP TABLE person_identities_old;
    `);
  }
  if (!hasColumn(db, 'pending', 'tenant_id')) {
    db.exec(`
      ALTER TABLE pending RENAME TO pending_old;
      CREATE TABLE pending (
        tenant_id TEXT NOT NULL DEFAULT 'default', chat_id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (tenant_id, chat_id)
      );
      INSERT INTO pending (tenant_id, chat_id, data) SELECT 'default', chat_id, data FROM pending_old;
      DROP TABLE pending_old;
    `);
  }
  if (!hasColumn(db, 'leads', 'tenant_id')) {
    db.exec(`
      ALTER TABLE leads RENAME TO leads_old;
      CREATE TABLE leads (
        tenant_id TEXT NOT NULL DEFAULT 'default', person_id TEXT NOT NULL,
        platform TEXT, source TEXT, display_name TEXT, first_message TEXT,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, person_id)
      );
      INSERT INTO leads (tenant_id, person_id, platform, source, display_name, first_message, status, created_at, updated_at)
        SELECT 'default', person_id, platform, source, display_name, first_message, status, created_at, updated_at FROM leads_old;
      DROP TABLE leads_old;
    `);
  }
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
