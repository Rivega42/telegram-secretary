/**
 * Тесты на исправления корректности:
 *  - гонка «владелец ответил во время генерации» → задача помечается отменённой
 *  - дедупликация переживает рестарт (SQLite, не in-memory)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TMP = fs.mkdtempSync('/tmp/secretary-test-correctness-');
process.env.STATE_DIR = TMP;

const {
  setExecuteCallback, createPending, cancelPending, executePendingNow, getAllPending
} = await import('../src/scheduler.js');
const { markProcessed, unmarkProcessed, pruneProcessed } = await import('../src/state.js');
const { closeDb } = await import('../src/core/db.js');

test('гонка: отмена во время генерации помечает выполняющуюся задачу', async () => {
  let observed = null;
  setExecuteCallback(async (task) => {
    // имитируем: владелец ответил сам, пока «генерируется» ответ
    const ret = cancelPending(task.businessChatId, 'owner replied mid-generation');
    observed = { cancelReturn: ret, taskCancelled: task.cancelled };
  });

  const mapping = { mappingId: 'm1', business_chat_id: 42, business_connection_id: 'c1' };
  createPending(mapping, { sender_id: '7', sender_name: 'X' }, 'привет', { delayMs: 999999, personId: 'person-0001' });

  await executePendingNow(42);

  assert.equal(observed.cancelReturn, true, 'cancelPending должен найти выполняющуюся задачу');
  assert.equal(observed.taskCancelled, true, 'флаг cancelled должен стоять у задачи, которую держит исполнитель');
  assert.equal(Object.keys(getAllPending()).length, 0, 'очередь пуста после выполнения');
});

test('дедупликация: повтор отбрасывается и переживает рестарт БД', () => {
  assert.equal(markProcessed('tg:1001'), true);  // новое
  assert.equal(markProcessed('tg:1001'), false); // дубль

  // «рестарт»: закрываем БД, следующий вызов переоткроет
  closeDb();
  assert.equal(markProcessed('tg:1001'), false, 'после рестарта повтор всё ещё дедуплицируется');

  // снятие пометки (ошибка обработки) разрешает повторную обработку
  unmarkProcessed('tg:1001');
  assert.equal(markProcessed('tg:1001'), true);
});

test('дедупликация: ключи платформ не пересекаются', () => {
  assert.equal(markProcessed('vk:42'), true);
  assert.equal(markProcessed('wa:42'), true);  // тот же id, другая платформа — не дубль
  assert.equal(markProcessed('tg:42'), true);
});

test('pruneProcessed: удаляет записи старше TTL', async () => {
  markProcessed('tg:old-1');
  await new Promise(r => setTimeout(r, 5)); // запись «стареет» на 5мс
  pruneProcessed(0); // cutoff = now → запись 5мс назад удаляется
  assert.equal(markProcessed('tg:old-1'), true, 'после очистки ключ снова свободен');
});
