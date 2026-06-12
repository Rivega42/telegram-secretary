/**
 * Тесты конверта сообщения и telegram-коннектора (преобразование в конверт).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.STATE_DIR = '/tmp/secretary-test-envelope';

const { createEnvelope, routingKey } = await import('../src/core/envelope.js');
const { toEnvelope, detectAttachments } = await import('../src/connectors/telegram/business.js');

test('createEnvelope: обязательные поля и дефолтные capabilities', () => {
  const env = createEnvelope({
    platform: 'telegram',
    surface: 'dm',
    identity: { platform_user_id: 42, username: 'u', display_name: 'User' },
    threadKey: 'telegram:dm:42',
    text: 'привет'
  });
  assert.equal(env.identity.platform_user_id, '42'); // нормализуется в строку
  assert.equal(env.capabilities.typing, false);
  assert.equal(env.text, 'привет');
  assert.equal(routingKey(env), 'telegram:dm');
});

test('createEnvelope: неизвестная поверхность отклоняется', () => {
  assert.throws(() => createEnvelope({
    platform: 'telegram',
    surface: 'nope',
    identity: { platform_user_id: 1 },
    threadKey: 'k'
  }), /unknown surface/);
});

test('toEnvelope: business_message → конверт, telegram-поля только в raw', () => {
  const env = toEnvelope({
    business_connection_id: 'conn1',
    message_id: 7,
    chat: { id: 100 },
    from: { id: 42, username: 'ivan', first_name: 'Иван', last_name: 'Петров' },
    text: 'привет'
  });
  assert.equal(env.platform, 'telegram');
  assert.equal(env.surface, 'dm');
  assert.equal(env.identity.display_name, 'Иван Петров');
  assert.equal(env.thread_key, 'telegram:dm:100');
  assert.equal(env.raw.business_connection_id, 'conn1');
  assert.equal(env.capabilities.typing, true);
  // ядро не должно видеть telegram-полей вне raw
  assert.ok(!('business_connection_id' in env));
});

test('detectAttachments: голос и фото распознаются, текст подписи сохраняется', () => {
  const env = toEnvelope({
    business_connection_id: 'c',
    chat: { id: 1 },
    from: { id: 2, first_name: 'X' },
    caption: 'подпись',
    photo: [{ file_id: 'f' }],
    voice: { file_id: 'v' }
  });
  assert.deepEqual(env.attachments.map(a => a.type).sort(), ['photo', 'voice']);
  assert.equal(env.text, 'подпись');
  assert.deepEqual(detectAttachments({}), []);
});
