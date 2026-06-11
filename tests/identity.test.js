/**
 * Тесты identity-слоя: персоны, политики, слияние (только явное).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TMP = fs.mkdtempSync('/tmp/secretary-test-identity-');
process.env.STATE_DIR = TMP;

const { resolvePerson, getPerson, getPersons, setPersonPolicy, mergePersons } =
  await import('../src/core/identity.js');

test('resolvePerson: создание новой персоны и повторный резолв того же человека', () => {
  const p1 = resolvePerson({ platform: 'telegram', platformUserId: 111, displayName: 'Иван', username: 'ivan' });
  assert.equal(p1.isNew, true);
  assert.equal(p1.policy, 'auto');
  assert.equal(p1.identities.telegram, '111');

  const p2 = resolvePerson({ platform: 'telegram', platformUserId: '111' });
  assert.equal(p2.isNew, false);
  assert.equal(p2.id, p1.id);
  assert.equal(p2.display_name, 'Иван'); // имя сохранилось
});

test('resolvePerson: тот же ID на другой платформе — ДРУГАЯ персона (нет автосклейки)', () => {
  const tg = resolvePerson({ platform: 'telegram', platformUserId: 222 });
  const vk = resolvePerson({ platform: 'vk', platformUserId: 222 });
  assert.notEqual(tg.id, vk.id);
});

test('setPersonPolicy: валидация и сохранение', () => {
  const p = resolvePerson({ platform: 'telegram', platformUserId: 333 });
  assert.equal(setPersonPolicy(p.id, 'escalate').ok, true);
  assert.equal(getPerson(p.id).policy, 'escalate');
  assert.equal(setPersonPolicy(p.id, 'nonsense').ok, false);
  assert.equal(setPersonPolicy('person-9999', 'auto').ok, false);
});

test('mergePersons: явное слияние переносит identity, конфликт отклоняется', () => {
  const tg = resolvePerson({ platform: 'telegram', platformUserId: 444 });
  const vk = resolvePerson({ platform: 'vk', platformUserId: 'id444' });

  const merged = mergePersons(tg.id, vk.id);
  assert.equal(merged.ok, true);
  assert.equal(merged.person.identities.vk, 'id444');
  assert.equal(getPerson(vk.id), null); // источник удалён
  // резолв по vk-identity теперь ведёт в объединённую персону
  assert.equal(resolvePerson({ platform: 'vk', platformUserId: 'id444' }).id, tg.id);

  // конфликт: обе персоны имеют разные telegram-identity
  const other = resolvePerson({ platform: 'telegram', platformUserId: 555 });
  assert.equal(mergePersons(tg.id, other.id).ok, false);
});

test('getPersons: возвращает все персоны с id', () => {
  const persons = getPersons();
  assert.ok(Object.keys(persons).length >= 3);
  for (const [id, p] of Object.entries(persons)) assert.equal(p.id, id);
});
