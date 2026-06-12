/**
 * Тесты публичных поверхностей: классификация комментарии/чат, триггеры,
 * rate-limit, draft-поток публичного ответа.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TMP = fs.mkdtempSync('/tmp/secretary-test-community-');
process.env.STATE_DIR = TMP;
process.env.PERSONA_DIR = './persona';
process.env.DRY_RUN = 'true';
process.env.DRY_RUN_BRAIN = 'true';
process.env.OWNER_CHAT_ID = '1';
process.env.ONEINT_BOT_TOKEN = 'dummy';
process.env.RATELIMIT_PER_USER = '2';
process.env.RATELIMIT_PER_CHAT = '3';
delete process.env.PUBLIC_AUTO_REPLY;

const { classifySurface, shouldReply, toEnvelope, handleGroupMessage } =
  await import('../src/connectors/telegram/community.js');
const { allowReply, resetRateLimits } = await import('../src/core/ratelimit.js');
const { getDraft } = await import('../src/core/drafts.js');

const BOT = { botUsername: 'SecretaryBot', botId: 42 };

function groupMsg(overrides = {}) {
  return {
    message_id: 100,
    chat: { id: -100123, type: 'supergroup', title: 'Обсуждение' },
    from: { id: 777, username: 'ivan', first_name: 'Иван' },
    text: 'обычное сообщение',
    ...overrides
  };
}

test('classifySurface: комментарий к посту vs обычный чат vs не-группа', () => {
  assert.equal(classifySurface(groupMsg()), 'group');
  assert.equal(classifySurface(groupMsg({
    reply_to_message: { is_automatic_forward: true, text: 'пост' }
  })), 'comments');
  assert.equal(classifySurface(groupMsg({ is_automatic_forward: true })), null);
  assert.equal(classifySurface({ chat: { id: 5, type: 'private' }, text: 'x' }), null);
});

test('shouldReply: упоминание, reply на бота, вопрос в комментариях', () => {
  // без триггера — молчим
  assert.equal(shouldReply(groupMsg(), 'group', BOT), false);
  // упоминание
  assert.equal(shouldReply(groupMsg({ text: 'а что скажет @SecretaryBot?' }), 'group', BOT), true);
  // reply на сообщение бота
  assert.equal(shouldReply(groupMsg({ reply_to_message: { from: { id: 42 } } }), 'group', BOT), true);
  // вопрос в комментариях — отвечаем; в чате — нет
  assert.equal(shouldReply(groupMsg({ text: 'сколько стоит?' }), 'comments', BOT), true);
  assert.equal(shouldReply(groupMsg({ text: 'сколько стоит?' }), 'group', BOT), false);
});

test('toEnvelope: surface, thread_key, текст поста в raw', () => {
  const env = toEnvelope(groupMsg({
    message_thread_id: 55,
    reply_to_message: { is_automatic_forward: true, text: 'Анонс продукта' },
    text: 'А цена?'
  }), 'comments');
  assert.equal(env.surface, 'comments');
  assert.equal(env.thread_key, 'telegram:comments:-100123:55');
  assert.equal(env.raw.post_text, 'Анонс продукта');
});

test('rate-limit: квоты на человека и чат, отказ не расходует квоту', () => {
  resetRateLimits();
  assert.equal(allowReply('c1', 'u1'), true);
  assert.equal(allowReply('c1', 'u1'), true);
  assert.equal(allowReply('c1', 'u1'), false); // лимит 2 на человека
  assert.equal(allowReply('c1', 'u2'), true);  // другой человек — ок (3-й в чате)
  assert.equal(allowReply('c1', 'u3'), false); // лимит 3 на чат
  assert.equal(allowReply('c2', 'u1'), true);  // другой чат — своя квота
  resetRateLimits();
});

test('handleGroupMessage: вопрос в комментариях → публичный черновик (не автоответ)', async () => {
  resetRateLimits();
  const msg = groupMsg({
    message_id: 200,
    reply_to_message: { is_automatic_forward: true, text: 'Пост про тарифы' },
    text: 'А есть скидки?'
  });
  const result = await handleGroupMessage(msg, BOT);
  assert.equal(result.action, 'draft');

  const draft = getDraft(result.draftKey);
  assert.ok(draft);
  assert.equal(draft.kind, 'community');
  assert.equal(draft.chat_id, -100123);
  assert.equal(draft.reply_to, 200);
  assert.ok(draft.text.length > 0);
});

test('handleGroupMessage: без триггера и при rate-limit — молчание', async () => {
  resetRateLimits();
  assert.equal((await handleGroupMessage(groupMsg(), BOT)).reason, 'no-trigger');

  // выжигаем квоту пользователя
  const q = (text, id) => groupMsg({ message_id: id, text: `@SecretaryBot ${text}` });
  await handleGroupMessage(q('раз?', 1), BOT);
  await handleGroupMessage(q('два?', 2), BOT);
  const third = await handleGroupMessage(q('три?', 3), BOT);
  assert.equal(third.reason, 'rate-limit');
  resetRateLimits();
});

test('handleGroupMessage: политика ignore работает и в группе', async () => {
  resetRateLimits();
  const { resolvePerson, setPersonPolicy } = await import('../src/core/identity.js');
  const p = resolvePerson({ platform: 'telegram', platformUserId: 888 });
  setPersonPolicy(p.id, 'ignore');
  const result = await handleGroupMessage(
    groupMsg({ from: { id: 888, first_name: 'Спамер' }, text: '@SecretaryBot купи?' }), BOT);
  assert.equal(result.reason, 'policy-ignore');
});
