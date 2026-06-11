/**
 * persona.js — персона секретаря из конфига (не из кода)
 *
 * Каталог PERSONA_DIR (по умолчанию ./persona):
 *   persona.json — имя секретаря, данные владельца, disclosure-матрица, fallback-ответы
 *   base.md      — общий характер и красные линии (поддерживает {{шаблоны}})
 *   dm.md        — стиль для лички
 *   public.md    — стиль для публичных поверхностей (comments, channel_post, group)
 *
 * Раскрытие ИИ-природы (disclosure) управляется флагом per-surface из persona.json,
 * а не текстом md-файлов — см. docs/openclaw-integration.md, раздел 5.
 */

import fs from 'fs';
import path from 'path';

const PERSONA_DIR = process.env.PERSONA_DIR || './persona';

// Нейтральная персона, если каталог не настроен. Без имён и личных данных —
// см. CLAUDE.md («не хардкодить персону/имена в код»).
const GENERIC_PERSONA = {
  secretary_name: 'Ассистент',
  owner: { name: 'Владелец', username: '', info: '' },
  language: 'ru',
  disclosure: { dm: true, comments: true, channel_post: true, group: true },
  fallback_reply: 'Добрый день! Владелец получил ваше сообщение и ответит позже.',
  dry_run_reply: 'Добрый день! Я ассистент, владелец скоро ответит.'
};

const GENERIC_BASE_MD = `Ты — {{secretary_name}}, личный секретарь {{owner_name}}.
Тебе пишут в мессенджере. Отвечай вежливо, кратко и по делу, на языке собеседника.
Не обещай встреч, сроков и денег от имени владельца. По серьёзным вопросам говори,
что владелец получит сообщение и ответит лично.`;

let cache = null;

function readIfExists(filepath) {
  try {
    if (fs.existsSync(filepath)) return fs.readFileSync(filepath, 'utf-8');
  } catch (err) {
    console.error(`[Persona] Error reading ${filepath}:`, err.message);
  }
  return null;
}

export function renderTemplate(template, vars) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (m, key) =>
    vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : m
  );
}

export function loadPersona({ force = false } = {}) {
  if (cache && !force) return cache;

  let config = { ...GENERIC_PERSONA };
  const configRaw = readIfExists(path.join(PERSONA_DIR, 'persona.json'));
  if (configRaw) {
    try {
      const parsed = JSON.parse(configRaw);
      config = {
        ...GENERIC_PERSONA,
        ...parsed,
        owner: { ...GENERIC_PERSONA.owner, ...(parsed.owner || {}) },
        disclosure: { ...GENERIC_PERSONA.disclosure, ...(parsed.disclosure || {}) }
      };
    } catch (err) {
      console.error('[Persona] Invalid persona.json, using generic persona:', err.message);
    }
  } else {
    console.warn(`[Persona] ${PERSONA_DIR}/persona.json not found — using generic persona`);
  }

  const vars = templateVars(config);
  cache = {
    ...config,
    base_md: readIfExists(path.join(PERSONA_DIR, 'base.md')) || GENERIC_BASE_MD,
    surface_md: {
      dm: readIfExists(path.join(PERSONA_DIR, 'dm.md')) || '',
      comments: readIfExists(path.join(PERSONA_DIR, 'public.md')) || '',
      channel_post: readIfExists(path.join(PERSONA_DIR, 'public.md')) || '',
      group: readIfExists(path.join(PERSONA_DIR, 'public.md')) || ''
    },
    vars,
    fallback_reply: renderTemplate(config.fallback_reply, vars),
    dry_run_reply: renderTemplate(config.dry_run_reply, vars)
  };
  return cache;
}

function templateVars(config) {
  return {
    secretary_name: config.secretary_name,
    owner_name: config.owner.name,
    owner_username: config.owner.username,
    owner_info: config.owner.info
  };
}

/**
 * Системный промпт: base + стиль поверхности + блок disclosure.
 */
export function buildSystemPrompt(persona, surface = 'dm') {
  const parts = [renderTemplate(persona.base_md, persona.vars)];

  const surfaceMd = persona.surface_md[surface];
  if (surfaceMd) parts.push(renderTemplate(surfaceMd, persona.vars));

  const disclose = persona.disclosure[surface] !== false;
  if (disclose) {
    parts.push(
      'РАСКРЫТИЕ: ты — ИИ-ассистент. Не выдавай себя за человека; ' +
      'если собеседник спрашивает, человек ли ты, честно скажи, что ты ИИ-помощник владельца.'
    );
  } else {
    parts.push(
      'РАСКРЫТИЕ: владелец настроил тебя отвечать от имени живого секретаря. ' +
      'Не сообщай по своей инициативе, что ты ИИ.'
    );
  }

  return parts.join('\n\n');
}
