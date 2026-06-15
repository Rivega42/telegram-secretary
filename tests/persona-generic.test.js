/**
 * Тест нейтральной персоны: каталога нет → generic без имён (инвариант CLAUDE.md:
 * персона/имена не хардкодятся в код).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.STATE_DIR = fs.mkdtempSync('/tmp/secretary-test-personagen-');
process.env.PERSONA_DIR = '/tmp/secretary-no-such-persona-dir';

const { loadPersona, buildSystemPrompt } = await import('../src/core/persona.js');

test('generic-персона: без каталога — нейтральные имена, без личных данных', () => {
  const p = loadPersona({ force: true });
  assert.equal(p.secretary_name, 'Ассистент');
  assert.equal(p.owner.name, 'Владелец');
  const prompt = buildSystemPrompt(p, 'dm');
  assert.ok(!prompt.includes('Вика'));
  assert.ok(!prompt.includes('Роман'));
  assert.ok(!prompt.includes('grandhub'));
});

test('generic-персона: disclosure по умолчанию включён на всех поверхностях', () => {
  const p = loadPersona({ force: true });
  for (const surface of ['dm', 'comments', 'channel_post', 'group']) {
    assert.ok(buildSystemPrompt(p, surface).includes('ИИ-ассистент'), surface);
  }
});
