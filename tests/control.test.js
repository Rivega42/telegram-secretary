/**
 * Тесты control plane: режимы, черновики, обработчик команд/кнопок владельца.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TMP = fs.mkdtempSync('/tmp/secretary-test-control-');
process.env.STATE_DIR = TMP;
process.env.OWNER_CHAT_ID = '1';
process.env.DRY_RUN = 'true';        // notifyOwnerText не ходит в сеть
process.env.ONEINT_BOT_TOKEN = 'dummy';

const { getSettings, setMode, setDraft, MODES } = await import('../src/core/modes.js');
const { saveDraft, getDraft, deleteDraft } = await import('../src/core/drafts.js');
const { handleCommand, handleCallback, handleControlUpdate, getAwaitingInput, clearAwaitingInput } =
  await import('../src/connectors/telegram/control.js');
const { resolvePerson, getPerson } = await import('../src/core/identity.js');

test('modes: дефолт auto, смена и сохранение, невалидный режим отклоняется', () => {
  assert.equal(getSettings().mode, 'auto');
  assert.equal(setMode('off').ok, true);
  assert.equal(getSettings().mode, 'off');
  assert.equal(setMode('nonsense').ok, false);
  assert.deepEqual(MODES, ['auto', 'off', 'vacation']);
  setMode('auto');
});

test('drafts: сохранение, чтение, удаление', () => {
  saveDraft('m1', { text: 'черновик', original_text: 'вопрос' });
  assert.equal(getDraft('m1').text, 'черновик');
  assert.equal(deleteDraft('m1'), true);
  assert.equal(getDraft('m1'), null);
  assert.equal(deleteDraft('m1'), false);
});

test('команды: /off /vacation /on /draft /status /help', () => {
  assert.ok(handleCommand('/off').includes('выключены'));
  assert.equal(getSettings().mode, 'off');
  assert.ok(handleCommand('/vacation').includes('отпуск'));
  assert.equal(getSettings().mode, 'vacation');
  assert.ok(handleCommand('/on'));
  assert.equal(getSettings().mode, 'auto');

  assert.ok(handleCommand('/draft').includes('включены'));
  assert.equal(getSettings().draft, true);
  assert.ok(handleCommand('/draft').includes('выключены'));
  assert.equal(getSettings().draft, false);

  assert.ok(handleCommand('/status').includes('Режим'));
  assert.ok(handleCommand('/help').includes('/vacation'));
  assert.equal(handleCommand('/unknown'), null);
  // команда с упоминанием бота
  assert.ok(handleCommand('/status@MyBot').includes('Режим'));
});

test('callback: политика контакта через кнопку', async () => {
  const p = resolvePerson({ platform: 'telegram', platformUserId: 555 });
  const toast = await handleCallback(`pol:escalate:${p.id}`, {});
  assert.ok(toast.includes('только тебе'));
  assert.equal(getPerson(p.id).policy, 'escalate');

  const back = await handleCallback(`pol:auto:${p.id}`, {});
  assert.ok(back.includes('автоответ'));
  assert.equal(getPerson(p.id).policy, 'auto');
});

test('callback: draft ok/no/rw делегируются в actions', async () => {
  const calls = [];
  const actions = {
    approveDraft: async (id) => { calls.push(['ok', id]); return '📤 Отправлено'; },
    rejectDraft: (id) => { calls.push(['no', id]); return '🗑'; },
  };
  assert.equal(await handleCallback('draft:ok:m42', actions), '📤 Отправлено');
  assert.equal(await handleCallback('draft:no:m42', actions), '🗑');
  assert.deepEqual(calls, [['ok', 'm42'], ['no', 'm42']]);

  // rw — ставит ожидание комментария
  clearAwaitingInput();
  await handleCallback('draft:rw:m42', actions);
  assert.deepEqual(getAwaitingInput(), { type: 'rewrite', mappingId: 'm42' });
  clearAwaitingInput();
});

test('callback: rep ставит ожидание текста владельца', async () => {
  clearAwaitingInput();
  const toast = await handleCallback('rep:abc123', {});
  assert.ok(toast.includes('Жду'));
  assert.deepEqual(getAwaitingInput(), { type: 'reply', mappingId: 'abc123' });
  clearAwaitingInput();
});

test('handleControlUpdate: чужие сообщения игнорируются, владелец — обрабатывается', async () => {
  // чужак шлёт команду — режим не меняется
  setMode('auto');
  await handleControlUpdate({ message: { from: { id: 999 }, text: '/off' } }, {});
  assert.equal(getSettings().mode, 'auto');

  // владелец шлёт команду
  await handleControlUpdate({ message: { from: { id: 1 }, text: '/off' } }, {});
  assert.equal(getSettings().mode, 'off');
  setMode('auto');
});

test('handleControlUpdate: свободный текст владельца уходит клиенту при ожидании', async () => {
  clearAwaitingInput();
  await handleCallback('rep:map77', {});
  const sent = [];
  await handleControlUpdate(
    { message: { from: { id: 1 }, text: 'Отвечу завтра!' } },
    { sendReplyToClient: async (mappingId, text) => { sent.push([mappingId, text]); return { ok: true }; } }
  );
  assert.deepEqual(sent, [['map77', 'Отвечу завтра!']]);
  assert.equal(getAwaitingInput(), null);
});
