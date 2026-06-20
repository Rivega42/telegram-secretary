/**
 * Тест апгрейда БД до-S2 (схема без tenant_id) → мультиарендная схема.
 * Существующие строки получают tenant_id='default', данные не теряются.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const TMP = fs.mkdtempSync('/tmp/secretary-test-tmigrate-');
process.env.STATE_DIR = TMP;
const DB_PATH = path.join(TMP, 'secretary.db');

// 1) Создаём БД по СТАРОЙ схеме (S1, без tenant_id) и наполняем
{
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE persons (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE person_identities (platform TEXT NOT NULL, platform_user_id TEXT NOT NULL, person_id TEXT NOT NULL, PRIMARY KEY (platform, platform_user_id));
    CREATE TABLE contacts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, ts TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL);
    CREATE TABLE pending (chat_id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE leads (person_id TEXT PRIMARY KEY, platform TEXT, source TEXT, display_name TEXT, first_message TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  db.prepare('INSERT INTO persons (id, data) VALUES (?, ?)').run('person-0001', JSON.stringify({ identities: { telegram: '42' }, policy: 'escalate', display_name: 'Старый' }));
  db.prepare('INSERT INTO person_identities (platform, platform_user_id, person_id) VALUES (?, ?, ?)').run('telegram', '42', 'person-0001');
  db.prepare('INSERT INTO contacts (id, data) VALUES (?, ?)').run('42', JSON.stringify({ id: 42, message_count: 5 }));
  db.prepare('INSERT INTO history (thread_id, ts, role, text) VALUES (?, ?, ?, ?)').run('abc', '2026-01-01T00:00:00Z', 'client', 'привет');
  db.prepare(`INSERT INTO meta (key, value) VALUES ('persons_seq', '1')`).run();
  db.close();
}

// 2) Открываем через приложение — getDb прогоняет migrateTenantId
const { getDb } = await import('../src/core/db.js');
const { runWithTenant } = await import('../src/core/context.js');
const { getPerson, resolvePerson } = await import('../src/core/identity.js');
const { getConversationHistory, getContacts } = await import('../src/state.js');

test('миграция: tenant_id добавлен во все таблицы данных', () => {
  const db = getDb();
  for (const t of ['persons', 'person_identities', 'contacts', 'history', 'pending', 'leads']) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    assert.ok(cols.includes('tenant_id'), `${t} должен иметь tenant_id`);
  }
});

test('миграция: старые данные доступны как арендатор default', () => {
  runWithTenant('default', () => {
    const p = getPerson('person-0001');
    assert.ok(p, 'персона перенесена');
    assert.equal(p.policy, 'escalate');
    // резолв по старой identity находит её, не создаёт новую
    const r = resolvePerson({ platform: 'telegram', platformUserId: 42 });
    assert.equal(r.id, 'person-0001');
    assert.equal(r.isNew, false);

    assert.equal(getContacts()['42'].message_count, 5);
    assert.equal(getConversationHistory('abc', 10)[0].text, 'привет');
  });
});

test('миграция: другой арендатор НЕ видит мигрированные default-данные', () => {
  runWithTenant('other', () => {
    assert.equal(getPerson('person-0001'), null);
    // тот же telegram id 42 в другом арендаторе — новая персона
    const r = resolvePerson({ platform: 'telegram', platformUserId: 42 });
    assert.equal(r.isNew, true);
    assert.notEqual(r.id, 'person-0001');
  });
});
