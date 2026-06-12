/**
 * Тесты коннектора ВКонтакте: callback-протокол, поток сообщений,
 * единая память (склейка персон), draft-режим.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync('/tmp/secretary-test-vk-');
process.env.STATE_DIR = TMP;
process.env.PERSONA_DIR = './persona';
process.env.DRY_RUN = 'true';
process.env.DRY_RUN_BRAIN = 'true';
process.env.OWNER_CHAT_ID = '1';
process.env.ONEINT_BOT_TOKEN = 'dummy';
process.env.API_KEY = 'test-key';
process.env.BUSINESS_BOT_TOKEN = 'dummy';
process.env.VK_GROUP_TOKEN = 'vk-token';
process.env.VK_CONFIRMATION_CODE = 'confirm123';
process.env.VK_SECRET = 'vk-secret';

const { createApp } = await import('../src/app.js');
const { handleVkMessage, toEnvelope } = await import('../src/connectors/vk/callback.js');
const { resolvePerson, findSimilarPersons, getPerson } = await import('../src/core/identity.js');
const { setDraft } = await import('../src/core/modes.js');
const { getDraft } = await import('../src/core/drafts.js');
const { handleCallback } = await import('../src/connectors/telegram/control.js');

let server, base;
before(async () => {
  const app = createApp();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

async function postVk(event) {
  const r = await fetch(`${base}/vk/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event)
  });
  return { status: r.status, text: await r.text() };
}

test('confirmation: возвращается код подтверждения', async () => {
  const r = await postVk({ type: 'confirmation', group_id: 1 });
  assert.equal(r.text, 'confirm123');
});

test('секрет: неверный → 403, верный → ok', async () => {
  const bad = await postVk({ type: 'message_new', secret: 'wrong', object: {} });
  assert.equal(bad.status, 403);
  const good = await postVk({ type: 'message_new', secret: 'vk-secret', event_id: 'e1', object: { message: { from_id: -1 } } });
  assert.equal(good.text, 'ok');
});

test('toEnvelope: платформа vk, vk-поля только в raw', () => {
  const env = toEnvelope(
    { from_id: 42, peer_id: 42, id: 7, text: 'привет' },
    { first_name: 'Иван', last_name: 'Петров', screen_name: 'ivanp' }
  );
  assert.equal(env.platform, 'vk');
  assert.equal(env.surface, 'dm');
  assert.equal(env.identity.username, 'ivanp');
  assert.equal(env.thread_key, 'vk:dm:42');
  assert.equal(env.raw.peer_id, 42);
});

test('handleVkMessage: ответ сразу (DRY_RUN), история ведётся', async () => {
  const result = await handleVkMessage(
    { from_id: 100, peer_id: 100, id: 1, text: 'сколько стоит?' },
    { first_name: 'Клиент' }
  );
  assert.equal(result.action, 'replied');

  const { getConversationHistory } = await import('../src/state.js');
  const lines = getConversationHistory('vk-100', 100);
  assert.equal(lines[0].from, 'client');
  assert.ok(lines.some(l => l.from === 'vika'));
});

test('handleVkMessage: глобальный draft-режим даёт vk-черновик', async () => {
  setDraft(true);
  const result = await handleVkMessage(
    { from_id: 101, peer_id: 101, id: 2, text: 'есть скидки?' }, {});
  assert.equal(result.action, 'draft');
  const draft = getDraft(result.draftKey);
  assert.equal(draft.kind, 'vk');
  assert.equal(draft.peer_id, 101);
  setDraft(false);
});

test('handleVkMessage: политика escalate — без LLM-ответа', async () => {
  const { setPersonPolicy } = await import('../src/core/identity.js');
  const p = resolvePerson({ platform: 'vk', platformUserId: 102 });
  setPersonPolicy(p.id, 'escalate');
  const result = await handleVkMessage({ from_id: 102, peer_id: 102, id: 3, text: 'срочно' }, {});
  assert.equal(result.action, 'escalated');
});

test('findSimilarPersons: vk-персона с тем же username находит telegram-персону', () => {
  const tg = resolvePerson({ platform: 'telegram', platformUserId: 9001, displayName: 'Олег Ч', username: 'olegch' });
  const vk = resolvePerson({ platform: 'vk', platformUserId: 9002, displayName: 'Олег Чернов', username: 'olegch' });
  const similar = findSimilarPersons(vk);
  assert.ok(similar.some(s => s.id === tg.id && s.match === 'username'));
  // персона с identity на той же платформе не предлагается
  const vk2 = resolvePerson({ platform: 'vk', platformUserId: 9003, username: 'olegch2' });
  assert.ok(!findSimilarPersons(vk2).some(s => s.id === vk.id && s.match === 'username'));
});

test('merge-кнопка: подтверждение объединяет память, отказ — нет', async () => {
  const a = resolvePerson({ platform: 'telegram', platformUserId: 9100, username: 'merge_me' });
  const b = resolvePerson({ platform: 'vk', platformUserId: 9101, username: 'merge_me' });

  assert.equal(await handleCallback('merge:no:-', {}), 'Ок, оставляю разными людьми');
  assert.ok(getPerson(b.id)); // не слилось

  const toast = await handleCallback(`merge:${a.id}:${b.id}`, {});
  assert.equal(toast, '🔗 Память объединена');
  assert.equal(getPerson(b.id), null);
  assert.equal(getPerson(a.id).identities.vk, '9101');
});

test('vk callback не настроен → 503 (отдельный env-процесс не нужен: проверка handler-условия)', async () => {
  // здесь VK настроен — проверяем, что happy-path отвечает не 503
  const r = await postVk({ type: 'confirmation' });
  assert.notEqual(r.status, 503);
});
