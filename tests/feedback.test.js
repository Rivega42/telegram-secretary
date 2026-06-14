/**
 * Тесты петли качества: правки, оценки, few-shot в промпте, база знаний.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TMP = fs.mkdtempSync('/tmp/secretary-test-feedback-');
process.env.STATE_DIR = TMP;
process.env.PERSONA_DIR = './persona';

const { recordCorrection, recordRating, recentCorrections, feedbackStats } =
  await import('../src/core/feedback.js');
const { buildUserPrompt } = await import('../src/core/prompt.js');
const { loadPersona, buildSystemPrompt } = await import('../src/core/persona.js');
const { createEnvelope } = await import('../src/core/envelope.js');

test('recordCorrection + recentCorrections: правки копятся и отдаются для few-shot', () => {
  recordCorrection({ surface: 'dm', personId: 'p1', original: 'Здравствуйте.', note: 'теплее', corrected: 'Привет! Рада вам 😊' });
  recordCorrection({ surface: 'dm', personId: 'p1', original: 'Цена 100.', note: 'не называть цену', corrected: 'Уточню у владельца и вернусь.' });
  recordCorrection({ surface: 'comments', personId: 'p2', original: 'x', note: 'короче', corrected: 'y' });

  const dm = recentCorrections('dm', 5);
  assert.equal(dm.length, 2);
  assert.equal(dm[dm.length - 1].note, 'не называть цену'); // хронологический порядок
  // поверхности изолированы
  assert.equal(recentCorrections('comments', 5).length, 1);
});

test('recordRating + feedbackStats: считает лайки/дизлайки/правки за окно', () => {
  recordRating({ surface: 'dm', personId: 'p1', rating: 1 });
  recordRating({ surface: 'dm', personId: 'p1', rating: -1 });
  recordRating({ surface: 'dm', personId: 'p3', rating: 1 });
  const s = feedbackStats(24 * 3600000);
  assert.equal(s.likes, 2);
  assert.equal(s.dislikes, 1);
  assert.equal(s.corrections, 3); // из предыдущего теста
});

test('buildUserPrompt: правки подмешиваются как few-shot', () => {
  const env = createEnvelope({
    platform: 'telegram', surface: 'dm',
    identity: { platform_user_id: 1, display_name: 'X' },
    threadKey: 'telegram:dm:1', text: 'привет'
  });
  const persona = loadPersona({ force: true });
  const corrections = recentCorrections('dm', 2);
  const prompt = buildUserPrompt(env, { persona, corrections });
  assert.ok(prompt.includes('КАК ВЛАДЕЛЕЦ ПРАВИЛ ОТВЕТЫ'));
  assert.ok(prompt.includes('не называть цену'));
});

test('база знаний: facts.md попадает в системный промпт', () => {
  const persona = loadPersona({ force: true });
  const prompt = buildSystemPrompt(persona, 'dm');
  assert.ok(prompt.includes('БАЗА ЗНАНИЙ'));
});
