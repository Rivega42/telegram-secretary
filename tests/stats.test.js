/**
 * Тесты метрик и дайджеста.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TMP = fs.mkdtempSync('/tmp/secretary-test-stats-');
process.env.STATE_DIR = TMP;
process.env.OWNER_CHAT_ID = '1';
process.env.DRY_RUN = 'true';
process.env.ONEINT_BOT_TOKEN = 'dummy';

const { appendConversationHistory } = await import('../src/state.js');
const { resolvePerson } = await import('../src/core/identity.js');
const { computeStats, platformOf } = await import('../src/core/stats.js');
const { buildDigestText } = await import('../src/connectors/telegram/digest.js');

test('platformOf: префиксы thread_id → платформа', () => {
  assert.equal(platformOf('vk-123'), 'vk');
  assert.equal(platformOf('wa-79990'), 'whatsapp');
  assert.equal(platformOf('lead-555'), 'lead');
  assert.equal(platformOf('a1b2c3'), 'telegram'); // mappingId лички
});

test('computeStats: считает сообщения по ролям, платформам, диалогам', () => {
  // Telegram-личка: 2 входящих, 1 ответ секретаря
  appendConversationHistory('a1b2c3', 'client', 'привет');
  appendConversationHistory('a1b2c3', 'vika', 'добрый день');
  appendConversationHistory('a1b2c3', 'client', 'вопрос');
  // VK: 1 входящее
  appendConversationHistory('vk-100', 'client', 'сколько?');
  // WA: 1 входящее + 1 ответ
  appendConversationHistory('wa-79990', 'client', 'есть?');
  appendConversationHistory('wa-79990', 'vika', 'да');
  // владелец ответил сам
  appendConversationHistory('a1b2c3', 'owner', 'я сам');

  resolvePerson({ platform: 'telegram', platformUserId: 42 });

  const s = computeStats({ sinceMs: 24 * 3600000 });
  assert.equal(s.messages.incoming, 4);
  assert.equal(s.messages.secretary, 2);
  assert.equal(s.messages.owner, 1);
  assert.equal(s.active_conversations, 3); // a1b2c3, vk-100, wa-79990
  assert.equal(s.by_platform.telegram.incoming, 2);
  assert.equal(s.by_platform.vk.incoming, 1);
  assert.equal(s.by_platform.whatsapp.secretary, 1);
  assert.ok(s.persons.total >= 1);
});

test('computeStats: окно отсекает то, что вне периода', () => {
  // cutoff в будущем (отрицательное окно) → ни одно прошлое сообщение не попадает
  const s = computeStats({ sinceMs: -3600000 });
  assert.equal(s.messages.incoming, 0);
  assert.equal(s.active_conversations, 0);
});

test('buildDigestText: человекочитаемая сводка с разделами', () => {
  const txt = buildDigestText(24);
  assert.ok(txt.includes('Дайджест за 24 ч'));
  assert.ok(txt.includes('Сообщений:'));
  assert.ok(txt.includes('Активных диалогов:'));
  assert.ok(/Telegram|ВКонтакте|WhatsApp/.test(txt));
});
