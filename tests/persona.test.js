/**
 * Тесты персоны: загрузка из каталога persona/, шаблоны, disclosure per-surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.STATE_DIR = fs.mkdtempSync('/tmp/secretary-test-persona-');
process.env.PERSONA_DIR = './persona';

const { loadPersona, buildSystemPrompt, renderTemplate } = await import('../src/core/persona.js');

test('renderTemplate: подстановка и сохранение неизвестных ключей', () => {
  assert.equal(renderTemplate('Привет, {{name}}!', { name: 'Вика' }), 'Привет, Вика!');
  assert.equal(renderTemplate('{{unknown}}', {}), '{{unknown}}');
});

test('loadPersona: персона из каталога persona/ репозитория', () => {
  const p = loadPersona({ force: true });
  assert.equal(p.secretary_name, 'Вика');
  assert.equal(p.owner.name, 'Роман');
  assert.ok(p.fallback_reply.includes('Роман')); // шаблон отрендерен
  assert.ok(p.base_md.length > 100);
});

test('buildSystemPrompt: имена подставлены, хардкода в коде нет', () => {
  const p = loadPersona({ force: true });
  const prompt = buildSystemPrompt(p, 'dm');
  assert.ok(prompt.includes('ВИКА') || prompt.includes('Вика'));
  assert.ok(!prompt.includes('{{')); // все шаблоны отрендерены
});

test('disclosure: личка без раскрытия, публичные поверхности — с раскрытием', () => {
  const p = loadPersona({ force: true });
  const dm = buildSystemPrompt(p, 'dm');
  const comments = buildSystemPrompt(p, 'comments');
  assert.ok(dm.includes('Не сообщай по своей инициативе'));
  assert.ok(comments.includes('ИИ-ассистент'));
  assert.ok(comments.includes('ПУБЛИЧНАЯ ПОВЕРХНОСТЬ')); // public.md подключён
});
