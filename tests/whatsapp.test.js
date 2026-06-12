/**
 * Тесты коннектора WhatsApp: верификация webhook, подпись, поток сообщений,
 * draft-режим, политики, дедупликация.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

const TMP = fs.mkdtempSync('/tmp/secretary-test-wa-');
process.env.STATE_DIR = TMP;
process.env.PERSONA_DIR = './persona';
process.env.DRY_RUN = 'true';
process.env.DRY_RUN_BRAIN = 'true';
process.env.OWNER_CHAT_ID = '1';
process.env.ONEINT_BOT_TOKEN = 'dummy';
process.env.API_KEY = 'test-key';
process.env.BUSINESS_BOT_TOKEN = 'dummy';
process.env.WA_TOKEN = 'wa-token';
process.env.WA_PHONE_NUMBER_ID = '123456';
process.env.WA_VERIFY_TOKEN = 'verify-me';
process.env.WA_APP_SECRET = 'app-secret';

const { createApp } = await import('../src/app.js');
const { handleWaMessage, toEnvelope } = await import('../src/connectors/whatsapp/webhook.js');
const { setDraft } = await import('../src/core/modes.js');
const { getDraft } = await import('../src/core/drafts.js');
const { getConversationHistory } = await import('../src/state.js');

let server, base;
before(async () => {
  const app = createApp();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(JSON.stringify(body)).digest('hex');
}

async function postWa(body, headers = {}) {
  const r = await fetch(`${base}/wa/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(body), ...headers },
    body: JSON.stringify(body)
  });
  return { status: r.status, text: await r.text() };
}

test('GET-верификация: верный токен → challenge, неверный → 403', async () => {
  const ok = await fetch(`${base}/wa/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=ch42`);
  assert.equal(await ok.text(), 'ch42');
  const bad = await fetch(`${base}/wa/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`);
  assert.equal(bad.status, 403);
});

test('подпись: неверная → 403, верная → ok', async () => {
  const body = { entry: [] };
  const bad = await postWa(body, { 'X-Hub-Signature-256': 'sha256=deadbeef' });
  assert.equal(bad.status, 403);
  const good = await postWa(body);
  assert.equal(good.text, 'ok');
});

test('toEnvelope: платформа whatsapp, wa-поля в raw', () => {
  const env = toEnvelope({ from: '79991234567', id: 'wamid.1', type: 'text', text: { body: 'привет' } }, 'Иван');
  assert.equal(env.platform, 'whatsapp');
  assert.equal(env.thread_key, 'whatsapp:dm:79991234567');
  assert.equal(env.identity.display_name, 'Иван');
  assert.equal(env.raw.wa_id, '79991234567');
});

test('handleWaMessage: ответ сразу (DRY_RUN), история ведётся', async () => {
  const result = await handleWaMessage(
    { from: '79990000001', id: 'wamid.a', type: 'text', text: { body: 'сколько стоит?' } }, 'Клиент');
  assert.equal(result.action, 'replied');
  const lines = getConversationHistory('wa-79990000001', 100);
  assert.equal(lines[0].from, 'client');
  assert.ok(lines.some(l => l.from === 'vika'));
});

test('handleWaMessage: draft-режим даёт wa-черновик', async () => {
  setDraft(true);
  const result = await handleWaMessage(
    { from: '79990000002', id: 'wamid.b', type: 'text', text: { body: 'скидки есть?' } }, '');
  assert.equal(result.action, 'draft');
  assert.equal(getDraft(result.draftKey).kind, 'wa');
  setDraft(false);
});

test('handleWaMessage: политика escalate и не-текст — без автоответа', async () => {
  const { resolvePerson, setPersonPolicy } = await import('../src/core/identity.js');
  const p = resolvePerson({ platform: 'whatsapp', platformUserId: '79990000003' });
  setPersonPolicy(p.id, 'escalate');
  const esc = await handleWaMessage(
    { from: '79990000003', id: 'wamid.c', type: 'text', text: { body: 'срочно' } }, '');
  assert.equal(esc.action, 'escalated');

  const voice = await handleWaMessage({ from: '79990000004', id: 'wamid.d', type: 'audio' }, '');
  assert.equal(voice.reason, 'non-text');
});

test('webhook-поток: вложенная структура entry/changes + дедупликация по message.id', async () => {
  const body = {
    entry: [{
      changes: [{
        value: {
          contacts: [{ wa_id: '79990000005', profile: { name: 'Олег' } }],
          messages: [{ from: '79990000005', id: 'wamid.dup', type: 'text', text: { body: 'тест' } }]
        }
      }]
    }]
  };
  assert.equal((await postWa(body)).text, 'ok');
  await new Promise(r => setTimeout(r, 100)); // асинхронная обработка
  const before = getConversationHistory('wa-79990000005', 100).length;
  assert.ok(before >= 1);

  // повторная доставка того же message.id не дублирует историю
  await postWa(body);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(getConversationHistory('wa-79990000005', 100).length, before);
});
