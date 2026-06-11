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

test('health: отвечает и показывает dry_run', async () => {
  const r = await fetch(`${base}/health`);
  const body = await r.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.env.dry_run, true);
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

  // история содержит реплику владельца
  const convDir = path.join(TMP, 'conversations');
  const files = fs.readdirSync(convDir);
  const lines = files.flatMap(f =>
    fs.readFileSync(path.join(convDir, f), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
  );
  const ownerLines = lines.filter(l => l.from === 'owner');
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
