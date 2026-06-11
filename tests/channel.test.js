/**
 * Тесты автопостинга, лид-воронки и ротации логов.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync('/tmp/secretary-test-channel-');
process.env.STATE_DIR = TMP;
process.env.PERSONA_DIR = './persona';
process.env.DRY_RUN = 'true';
process.env.DRY_RUN_BRAIN = 'true';
process.env.OWNER_CHAT_ID = '1';
process.env.ONEINT_BOT_TOKEN = 'dummy';
process.env.CHANNEL_ID = '@test_channel';
process.env.LOG_TTL_DAYS = '30';

const { loadPlan, savePlan, nextTopic, recordPosted, generatePost } =
  await import('../src/connectors/telegram/channel.js');
const { getDraft } = await import('../src/core/drafts.js');
const { handleLeadMessage } = await import('../src/connectors/telegram/community.js');
const { rotateLogs } = await import('../src/state.js');

test('контент-план: ротация тем по кругу', () => {
  savePlan({ topics: ['тема А', 'тема Б'], next_index: 0, posted: [] });
  assert.equal(nextTopic(), 'тема А');
  assert.equal(nextTopic(), 'тема Б');
  assert.equal(nextTopic(), 'тема А'); // по кругу
});

test('контент-план: пустой план → null, recordPosted ведёт журнал', () => {
  savePlan({ topics: [], next_index: 0, posted: [] });
  assert.equal(nextTopic(), null);
  recordPosted('тема X', 'текст поста');
  assert.equal(loadPlan().posted.length, 1);
  assert.equal(loadPlan().posted[0].topic, 'тема X');
});

test('generatePost: черновик в канал с темой и envelope (без публикации)', async () => {
  savePlan({ topics: ['запуск продукта'], next_index: 0, posted: [] });
  const result = await generatePost();
  assert.equal(result.ok, true);
  assert.equal(result.topic, 'запуск продукта');

  const draft = getDraft(result.draftKey);
  assert.equal(draft.kind, 'channel');
  assert.equal(draft.chat_id, '@test_channel');
  assert.ok(draft.envelope, 'envelope нужен для «Переписать»');
  assert.ok(draft.text.length > 0);
});

test('generatePost: явная тема обходит контент-план', async () => {
  const result = await generatePost('специальная тема');
  assert.equal(result.topic, 'специальная тема');
});

test('лид-воронка: deep-link источник, автоответ, история', async () => {
  const msg = {
    message_id: 1,
    chat: { id: 555, type: 'private' },
    from: { id: 555, username: 'lead1', first_name: 'Лид' },
    text: '/start post_42'
  };
  const result = await handleLeadMessage(msg);
  assert.equal(result.action, 'lead-replied');
  assert.equal(result.source, 'post_42');

  // история лида ведётся, источник зафиксирован
  const file = path.join(TMP, 'conversations', 'lead-555.jsonl');
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(lines[0].text.includes('пришёл с: post_42'));
  assert.ok(lines.some(l => l.from === 'vika')); // автоответ записан (DRY_RUN ok)
});

test('лид-воронка: политика ignore молчит', async () => {
  const { resolvePerson, setPersonPolicy } = await import('../src/core/identity.js');
  const p = resolvePerson({ platform: 'telegram', platformUserId: 666 });
  setPersonPolicy(p.id, 'ignore');
  const result = await handleLeadMessage({
    chat: { id: 666, type: 'private' },
    from: { id: 666, first_name: 'Спам' },
    text: 'купите'
  });
  assert.equal(result.reason, 'policy-ignore');
});

test('rotateLogs: старые логи удаляются, свежие остаются', () => {
  const old = path.join(TMP, 'log-2020-01-01.jsonl');
  const today = new Date().toISOString().split('T')[0];
  const fresh = path.join(TMP, `log-${today}.jsonl`);
  fs.writeFileSync(old, '{}\n');
  fs.writeFileSync(fresh, '{}\n');

  const removed = rotateLogs(30);
  assert.ok(removed >= 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);

  // ttl 0 — ротация выключена
  fs.writeFileSync(old, '{}\n');
  assert.equal(rotateLogs(0), 0);
  assert.equal(fs.existsSync(old), true);
});
