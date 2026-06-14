/**
 * Тесты изоляции данных по арендаторам (SaaS, фаза S2).
 * Главный инвариант: арендатор A не видит персон/историю/лиды/контакты/маппинги
 * арендатора B — даже при совпадающих платформенных id.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TMP = fs.mkdtempSync('/tmp/secretary-test-isolation-');
process.env.STATE_DIR = TMP;

const { runWithTenant, currentTenantId } = await import('../src/core/context.js');
const { resolvePerson, getPersons, getPerson, setPersonPolicy } = await import('../src/core/identity.js');
const { appendConversationHistory, getConversationHistory, getOrCreateMapping, findMappingByChat, updateContact, getContacts } = await import('../src/state.js');
const { recordLead, listLeads } = await import('../src/core/leads.js');

test('контекст: по умолчанию default', () => {
  assert.equal(currentTenantId(), 'default');
});

test('персоны: одинаковый platform_user_id у разных арендаторов — разные персоны', () => {
  const a = runWithTenant('acme', () => resolvePerson({ platform: 'telegram', platformUserId: 100, displayName: 'A-Иван' }));
  const b = runWithTenant('beta', () => resolvePerson({ platform: 'telegram', platformUserId: 100, displayName: 'B-Иван' }));
  // оба новые, разные персоны, несмотря на один и тот же telegram id
  assert.equal(a.isNew, true);
  assert.equal(b.isNew, true);
  assert.notEqual(a.id, b.id);

  // A видит только свою персону, B — только свою
  const aPersons = runWithTenant('acme', () => getPersons());
  const bPersons = runWithTenant('beta', () => getPersons());
  assert.ok(aPersons[a.id]);
  assert.ok(!aPersons[b.id]);
  assert.ok(bPersons[b.id]);
  assert.ok(!bPersons[a.id]);

  // getPerson чужого арендатора не отдаёт
  assert.equal(runWithTenant('acme', () => getPerson(b.id)), null);
  // повторный резолв того же id в A находит персону A, не B
  const a2 = runWithTenant('acme', () => resolvePerson({ platform: 'telegram', platformUserId: 100 }));
  assert.equal(a2.id, a.id);
  assert.equal(a2.isNew, false);
});

test('политика: смена у A не трогает персону B', () => {
  const a = runWithTenant('acme', () => resolvePerson({ platform: 'vk', platformUserId: 7 }));
  const b = runWithTenant('beta', () => resolvePerson({ platform: 'vk', platformUserId: 7 }));
  runWithTenant('acme', () => setPersonPolicy(a.id, 'ignore'));
  assert.equal(runWithTenant('acme', () => getPerson(a.id)).policy, 'ignore');
  assert.equal(runWithTenant('beta', () => getPerson(b.id)).policy, 'auto'); // не задет
  // A не может менять политику персоны B
  assert.equal(runWithTenant('acme', () => setPersonPolicy(b.id, 'ignore')).ok, false);
});

test('история: thread_id с одинаковым именем у A и B изолированы', () => {
  runWithTenant('acme', () => { appendConversationHistory('t1', 'client', 'A-привет'); });
  runWithTenant('beta', () => { appendConversationHistory('t1', 'client', 'B-привет'); });
  const aHist = runWithTenant('acme', () => getConversationHistory('t1', 10));
  const bHist = runWithTenant('beta', () => getConversationHistory('t1', 10));
  assert.equal(aHist.length, 1);
  assert.equal(aHist[0].text, 'A-привет');
  assert.equal(bHist[0].text, 'B-привет');
});

test('маппинги и контакты: одинаковый chat_id/user_id изолированы', () => {
  const aMap = runWithTenant('acme', () => getOrCreateMapping('conn', 500, { id: 1, first_name: 'A' }));
  const bMap = runWithTenant('beta', () => getOrCreateMapping('conn', 500, { id: 1, first_name: 'B' }));
  assert.notEqual(aMap.mappingId, bMap.mappingId);
  // B не находит маппинг A по тому же чату
  assert.equal(runWithTenant('beta', () => findMappingByChat('conn', 500)).mappingId, bMap.mappingId);

  runWithTenant('acme', () => updateContact({ id: 1, first_name: 'A' }));
  runWithTenant('beta', () => updateContact({ id: 1, first_name: 'B' }));
  assert.equal(runWithTenant('acme', () => getContacts())['1'].first_name, 'A');
  assert.equal(runWithTenant('beta', () => getContacts())['1'].first_name, 'B');
});

test('лиды: A не видит лиды B', () => {
  runWithTenant('acme', () => recordLead({ personId: 'p-shared', firstMessage: 'A-лид' }));
  runWithTenant('beta', () => recordLead({ personId: 'p-shared', firstMessage: 'B-лид' }));
  const aLeads = runWithTenant('acme', () => listLeads());
  const bLeads = runWithTenant('beta', () => listLeads());
  assert.equal(aLeads.length, 1);
  assert.equal(aLeads[0].first_message, 'A-лид');
  assert.equal(bLeads[0].first_message, 'B-лид');
});

test('default-арендатор не пересекается с A/B', () => {
  // данных в default нет — все писали в acme/beta
  assert.equal(getPersons() && Object.keys(getPersons()).length, 0);
  assert.equal(listLeads().length, 0);
});
