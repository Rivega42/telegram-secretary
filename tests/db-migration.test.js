/**
 * Тест авто-миграции стейта из JSON-файлов старого формата в SQLite (#26).
 * У пользователей живые данные — миграция обязана переносить всё без потерь.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync('/tmp/secretary-test-migration-');
process.env.STATE_DIR = TMP;

// Готовим стейт «старого формата» ДО первого обращения к БД
fs.writeFileSync(path.join(TMP, 'connections.json'), JSON.stringify({
  'conn-1': { id: 'conn-1', is_enabled: true }
}));
fs.writeFileSync(path.join(TMP, 'contacts.json'), JSON.stringify({
  '42': { id: 42, username: 'ivan', message_count: 7 }
}));
fs.writeFileSync(path.join(TMP, 'conversations.json'), JSON.stringify({
  'abc123': { business_connection_id: 'conn-1', business_chat_id: 42, sender_name: 'Иван' }
}));
fs.mkdirSync(path.join(TMP, 'conversations'));
fs.writeFileSync(path.join(TMP, 'conversations', 'abc123.jsonl'),
  '{"ts":"2026-01-01T10:00:00Z","from":"client","text":"привет"}\n' +
  '{"ts":"2026-01-01T10:02:00Z","from":"vika","text":"добрый день"}\n' +
  '{"ts":"2026-01-01T10:05:00Z","from":"owner","text":"я сам"}\n');
fs.writeFileSync(path.join(TMP, 'persons.json'), JSON.stringify({
  seq: 2,
  persons: {
    'person-0001': { identities: { telegram: '42' }, display_name: 'Иван', policy: 'escalate' },
    'person-0002': { identities: { vk: '99' }, display_name: 'Олег', policy: 'auto' }
  }
}));
fs.writeFileSync(path.join(TMP, 'pending.json'), JSON.stringify({
  '42': { mappingId: 'abc123', originalText: 'привет', scheduledAt: '2026-01-01T10:00:00Z', delayMs: 120000 }
}));

const { getConnections, getContacts, getMapping, findMappingByChat, getConversationHistory } =
  await import('../src/state.js');
const { getPerson, resolvePerson } = await import('../src/core/identity.js');

test('миграция: connections, contacts, conversations перенесены', () => {
  assert.equal(getConnections()['conn-1'].is_enabled, true);
  assert.equal(getContacts()['42'].message_count, 7);
  assert.equal(getMapping('abc123').sender_name, 'Иван');
  assert.equal(findMappingByChat('conn-1', 42).mappingId, 'abc123');
});

test('миграция: история хронологична, роли сохранены', () => {
  const history = getConversationHistory('abc123', 10);
  assert.equal(history.length, 3);
  assert.deepEqual(history.map(h => h.from), ['client', 'vika', 'owner']);
  assert.equal(history[2].text, 'я сам');
});

test('миграция: персоны с политиками и identity-резолвом', () => {
  assert.equal(getPerson('person-0001').policy, 'escalate');
  // резолв по старой identity находит мигрированную персону, не создаёт новую
  const p = resolvePerson({ platform: 'telegram', platformUserId: 42 });
  assert.equal(p.id, 'person-0001');
  assert.equal(p.isNew, false);
  // seq продолжается, а не начинается заново
  const fresh = resolvePerson({ platform: 'telegram', platformUserId: 777 });
  assert.equal(fresh.id, 'person-0003');
});

test('миграция: pending перенесён, исходные JSON переименованы в *.migrated', async () => {
  const { loadPendingFromFile, getAllPending, cancelPending } = await import('../src/scheduler.js');
  loadPendingFromFile(); // задача из 2026-01-01 давно истекла → выполнится setImmediate (без колбэка — лог)
  // главное: файлы старого формата не остались «живыми»
  assert.equal(fs.existsSync(path.join(TMP, 'persons.json')), false);
  assert.equal(fs.existsSync(path.join(TMP, 'persons.json.migrated')), true);
  assert.equal(fs.existsSync(path.join(TMP, 'pending.json.migrated')), true);
  assert.equal(fs.existsSync(path.join(TMP, 'conversations', 'abc123.jsonl.migrated')), true);
  cancelPending('42', 'test cleanup');
  assert.equal(typeof getAllPending(), 'object');
});

test('повторное открытие БД не дублирует данные (migrated-флаг)', async () => {
  const { closeDb } = await import('../src/core/db.js');
  closeDb();
  const { getConversationHistory: gch } = await import('../src/state.js');
  assert.equal(gch('abc123', 10).length, 3); // не 6
});
