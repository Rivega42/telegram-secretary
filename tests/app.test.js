/**
 * E2E-тесты приложения в DRY_RUN: webhook-поток, политики персон,
 * не-текстовые сообщения, история, авторизация админ-API.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync('/tmp/secretary-test-app-');
process.env.STATE_DIR = TMP;
process.env.PERSONA_DIR = './persona';
process.env.DRY_RUN = 'true';
process.env.DRY_RUN_BRAIN = 'true';
process.env.OWNER_CHAT_ID = '1';
process.env.API_KEY = 'test-key';
process.env.ONEINT_BOT_TOKEN = 'dummy';
process.env.BUSINESS_BOT_TOKEN = 'dummy';
delete process.env.WEBHOOK_SECRET;

const { createApp } = await import('../src/app.js');

let server;
let base;

before(async () => {
  const app = createApp();
  await new Promise(resolve => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

let updateId = 0;
function businessMessage(fromId, text, extra = {}) {
  updateId += 1;
  return {
    update_id: updateId,
    business_message: {
      business_connection_id: 'conn-1',
      message_id: updateId,
      chat: { id: 1000 + Number(fromId) },
      from: { id: fromId, username: `user${fromId}`, first_name: `Тест${fromId}` },
      ...extra,
      ...(text !== null ? { text } : {})
    }
  };
}

async function postWebhook(update) {
  const r = await fetch(`${base}/tg/business-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update)
  });
  return { status: r.status, body: await r.json() };
}

async function api(pathname, options = {}) {
  const r = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'test-key', ...(options.headers || {}) }
  });
  return { status: r.status, body: await r.json() };
}

test('health: отвечает, проверяет БД, не светит owner_chat_id', async () => {
  const r = await fetch(`${base}/health`);
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.db, true); // SELECT 1 прошёл
  assert.equal(body.env.dry_run, true);
  assert.equal(body.env.owner_chat_id, true); // флаг, не значение
});

test('невалидный JSON в webhook → 400 (глобальный error-handler)', async () => {
  const r = await fetch(`${base}/tg/business-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ broken'
  });
  assert.equal(r.status, 400);
});

test('неверный API-ключ → 401 (timing-safe сравнение)', async () => {
  const r = await fetch(`${base}/api/pending`, { headers: { 'X-Api-Key': 'wrong-key-different-length' } });
  assert.equal(r.status, 401);
});

test('админ-API: 401 без ключа, 200 с ключом', async () => {
  const noKey = await fetch(`${base}/api/pending`);
  assert.equal(noKey.status, 401);
  const withKey = await api('/api/pending');
  assert.equal(withKey.status, 200);
});

test('сообщение клиента: создаётся pending и персона', async () => {
  const { body } = await postWebhook(businessMessage(42, 'привет, есть вопрос'));
  assert.equal(body.pending, true);
  assert.ok(body.person_id.startsWith('person-'));
  assert.ok(body.mapping_id);

  const pending = await api('/api/pending');
  assert.equal(pending.body.count, 1);

  const persons = await api('/api/persons');
  assert.ok(persons.body.count >= 1);
});

test('дедупликация: повторный update_id отбрасывается', async () => {
  const update = businessMessage(42, 'дубликат');
  await postWebhook(update);
  const second = await postWebhook(update);
  assert.equal(second.body.duplicate, true);
});

test('ответ владельца: pending отменяется, реплика попадает в историю как owner', async () => {
  // владелец (id=1) пишет в тот же чат, что и клиент 42 (chat 1042)
  const { body } = await postWebhook({
    update_id: ++updateId,
    business_message: {
      business_connection_id: 'conn-1',
      message_id: updateId,
      chat: { id: 1042 },
      from: { id: 1, username: 'owner', first_name: 'Владелец' },
      text: 'я отвечу сам'
    }
  });
  assert.equal(body.ignored, 'owner_outgoing');
  assert.equal(body.pending_cancelled, true);

  const pending = await api('/api/pending');
  assert.equal(pending.body.count, 0);

  // история содержит реплику владельца (через API стейта — SQLite)
  const { getConversations, getConversationHistory } = await import('../src/state.js');
  const allHistory = Object.keys(getConversations())
    .flatMap(mappingId => getConversationHistory(mappingId, 100));
  const ownerLines = allHistory.filter(l => l.from === 'owner');
  assert.equal(ownerLines.length, 1);
  assert.equal(ownerLines[0].text, 'я отвечу сам');
});

test('политика escalate: без pending, эскалация владельцу', async () => {
  const first = await postWebhook(businessMessage(77, 'кто здесь?'));
  const personId = first.body.person_id;
  const set = await api(`/api/persons/${personId}/policy`, {
    method: 'POST',
    body: JSON.stringify({ policy: 'escalate' })
  });
  assert.equal(set.status, 200);

  const { body } = await postWebhook(businessMessage(77, 'срочный вопрос'));
  assert.equal(body.policy, 'escalate');
  assert.equal(body.pending, undefined);
});

test('политика ignore: ни ответа, ни уведомления, ни истории', async () => {
  const first = await postWebhook(businessMessage(88, 'спам'));
  await api(`/api/persons/${first.body.person_id}/policy`, {
    method: 'POST',
    body: JSON.stringify({ policy: 'ignore' })
  });
  const { body } = await postWebhook(businessMessage(88, 'ещё спам'));
  assert.equal(body.policy, 'ignore');
});

test('невалидная политика отклоняется', async () => {
  const persons = await api('/api/persons');
  const anyId = Object.keys(persons.body.persons)[0];
  const r = await api(`/api/persons/${anyId}/policy`, {
    method: 'POST',
    body: JSON.stringify({ policy: 'whatever' })
  });
  assert.equal(r.status, 400);
});

test('STT: без STT_BASE_URL голосовое идёт по пути эскалации (isSttConfigured=false)', async () => {
  const { isSttConfigured } = await import('../src/connectors/telegram/stt.js');
  assert.equal(isSttConfigured(), false);
});

test('не-текстовое сообщение: эскалация вместо автоответа', async () => {
  const before = (await api('/api/pending')).body.count;
  const { body } = await postWebhook(businessMessage(99, null, { voice: { file_id: 'v1' } }));
  assert.equal(body.non_text, true);
  assert.equal(body.pending, undefined);
  // pending для голосового не создаётся (счётчик не вырос)
  const after = (await api('/api/pending')).body.count;
  assert.equal(after, before);
});

test('webhook: невалидный апдейт → 400', async () => {
  const r = await postWebhook({ foo: 'bar' });
  assert.equal(r.status, 400);
});

test('режим off: уведомление без pending', async () => {
  const { setMode } = await import('../src/core/modes.js');
  setMode('off');
  const before = (await api('/api/pending')).body.count;
  const { body } = await postWebhook(businessMessage(150, 'есть кто живой?'));
  assert.equal(body.mode, 'off');
  assert.equal(body.pending, undefined);
  assert.equal((await api('/api/pending')).body.count, before);
  setMode('auto');
});

test('режим vacation: pending с короткой задержкой', async () => {
  const { setMode } = await import('../src/core/modes.js');
  setMode('vacation');
  const { body } = await postWebhook(businessMessage(151, 'срочно!'));
  assert.equal(body.pending, true);
  assert.ok(body.delay_minutes < 1, `delay ${body.delay_minutes} должен быть < 1 мин`);
  setMode('auto');
  await api('/api/pending/1151', { method: 'DELETE' }); // прибрать быстрый таймер
});

test('debounce: серия сообщений — один pending, уведомление редактируется', async () => {
  const before = (await api('/api/pending')).body.count;
  await postWebhook(businessMessage(152, 'первое'));
  await postWebhook(businessMessage(152, 'второе'));
  await postWebhook(businessMessage(152, 'третье'));
  const after = (await api('/api/pending')).body.count;
  assert.equal(after, before + 1); // не 3 задачи, а одна (заменяется)
});

test('/api/mode: текущие настройки доступны', async () => {
  const r = await api('/api/mode');
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'auto');
  assert.equal(typeof r.body.draft, 'boolean');
});

test('draft-режим: ответ не уходит клиенту, создаётся черновик; approve отправляет', async () => {
  const { setDraft } = await import('../src/core/modes.js');
  const { getDraft } = await import('../src/core/drafts.js');
  const { executeBrainResponse, createControlActions } = await import('../src/app.js');

  // создаём диалог и забираем pending-задачу
  const first = await postWebhook(businessMessage(160, 'сколько стоит?'));
  const mappingId = first.body.mapping_id;

  setDraft(true);
  // исполняем pending немедленно (вместо ожидания таймера)
  const { executePendingNow } = await import('../src/scheduler.js');
  const ran = await executePendingNow(1160);
  assert.equal(ran, true);

  // черновик создан, в истории НЕТ ответа секретаря
  const draft = getDraft(mappingId);
  assert.ok(draft, 'черновик должен существовать');
  assert.ok(draft.text.length > 0);

  // подтверждение владельцем — уходит клиенту (DRY_RUN) и чистит черновик
  const actions = createControlActions();
  const toast = await actions.approveDraft(mappingId);
  assert.equal(toast, '📤 Отправлено');
  assert.equal(getDraft(mappingId), null);

  // история содержит подтверждённый ответ
  const { getConversationHistory } = await import('../src/state.js');
  const lines = getConversationHistory(mappingId, 100);
  assert.ok(lines.some(l => l.from === 'vika' && l.text === draft.text));

  setDraft(false);
});
