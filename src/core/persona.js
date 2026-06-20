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
import { getDb } from './db.js';
import { currentTenantId, DEFAULT_TENANT } from './context.js';

const PERSONA_DIR = process.env.PERSONA_DIR || './persona';

// Нейтральная персона, если каталог не настроен. Без имён и личных данных —
// см. CLAUDE.md («не хардкодить персону/имена в код»).
const GENERIC_PERSONA = {
  secretary_name: 'Ассистент',
  owner: { name: 'Владелец', username: '', info: '' },
  language: 'ru',
  disclosure: { dm: true, comments: true, channel_post: true, group: true },
  // Тексты disclosure-блока можно переопределить в persona.json (поле disclosure_text)
  disclosure_text: {
    on: 'РАСКРЫТИЕ: ты — ИИ-ассистент. Не выдавай себя за человека; ' +
        'если собеседник спрашивает, человек ли ты, честно скажи, что ты ИИ-помощник владельца.',
    off: 'РАСКРЫТИЕ: владелец настроил тебя отвечать от имени живого секретаря. ' +
         'Не сообщай по своей инициативе, что ты ИИ.'
  },
  fallback_reply: 'Добрый день! Владелец получил ваше сообщение и ответит позже.',
  dry_run_reply: 'Добрый день! Я ассистент, владелец скоро ответит.'
};

const GENERIC_BASE_MD = `Ты — {{secretary_name}}, личный секретарь {{owner_name}}.
Тебе пишут в мессенджере. Отвечай вежливо, кратко и по делу, на языке собеседника.
Не обещай встреч, сроков и денег от имени владельца. По серьёзным вопросам говори,
что владелец получит сообщение и ответит лично.`;

// Кэш персоны по арендатору
const cache = new Map();

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

// Слить распарсенный persona.json с дефолтами
function mergeConfig(parsed) {
  return {
    ...GENERIC_PERSONA,
    ...(parsed || {}),
    owner: { ...GENERIC_PERSONA.owner, ...((parsed && parsed.owner) || {}) },
    disclosure: { ...GENERIC_PERSONA.disclosure, ...((parsed && parsed.disclosure) || {}) },
    disclosure_text: { ...GENERIC_PERSONA.disclosure_text, ...((parsed && parsed.disclosure_text) || {}) }
  };
}

// Собрать готовую персону из config + markdown-кусков
function assemble(config, md) {
  const vars = templateVars(config);
  return {
    ...config,
    base_md: md.base_md || GENERIC_BASE_MD,
    facts_md: md.facts_md || '',
    surface_md: {
      dm: md.dm_md || '',
      comments: md.public_md || '',
      channel_post: md.public_md || '',
      group: md.public_md || ''
    },
    vars,
    fallback_reply: renderTemplate(config.fallback_reply, vars),
    dry_run_reply: renderTemplate(config.dry_run_reply, vars)
  };
}

function loadFromFiles() {
  const raw = readIfExists(path.join(PERSONA_DIR, 'persona.json'));
  let parsed = null;
  if (raw) {
    try { parsed = JSON.parse(raw); }
    catch (err) { console.error('[Persona] Invalid persona.json, using generic:', err.message); }
  }
  return assemble(mergeConfig(parsed), {
    base_md: readIfExists(path.join(PERSONA_DIR, 'base.md')),
    facts_md: readIfExists(path.join(PERSONA_DIR, 'facts.md')),
    dm_md: readIfExists(path.join(PERSONA_DIR, 'dm.md')),
    public_md: readIfExists(path.join(PERSONA_DIR, 'public.md'))
  });
}

function loadFromDbRow(row) {
  let parsed = null;
  if (row.persona_json) {
    try { parsed = JSON.parse(row.persona_json); } catch { /* generic */ }
  }
  return assemble(mergeConfig(parsed), {
    base_md: row.base_md, facts_md: row.facts_md, dm_md: row.dm_md, public_md: row.public_md
  });
}

/**
 * Персона текущего арендатора:
 *  - есть запись в tenant_persona → из БД
 *  - арендатор default без записи → из файлов PERSONA_DIR (обратная совместимость)
 *  - прочие без записи → нейтральная generic-персона (без имён)
 */
export function loadPersona({ force = false } = {}) {
  const tenant = currentTenantId();
  if (!force && cache.has(tenant)) return cache.get(tenant);

  let row = null;
  try {
    row = getDb().prepare('SELECT * FROM tenant_persona WHERE tenant_id = ?').get(tenant);
  } catch { /* БД недоступна — деградируем к файлам/generic */ }

  let persona;
  if (row) persona = loadFromDbRow(row);
  else if (tenant === DEFAULT_TENANT) persona = loadFromFiles();
  else persona = assemble(mergeConfig(null), {}); // нейтральная

  cache.set(tenant, persona);
  return persona;
}

/**
 * Задать персону арендатора (admin/онбординг). Поля: persona_json (объект или строка),
 * base_md, dm_md, public_md, facts_md.
 */
export function setTenantPersona(tenantId, fields = {}) {
  const personaJson = fields.persona_json == null ? null
    : (typeof fields.persona_json === 'string' ? fields.persona_json : JSON.stringify(fields.persona_json));
  getDb().prepare(
    `INSERT OR REPLACE INTO tenant_persona (tenant_id, persona_json, base_md, dm_md, public_md, facts_md)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(tenantId, personaJson, fields.base_md ?? null, fields.dm_md ?? null, fields.public_md ?? null, fields.facts_md ?? null);
  cache.delete(tenantId);
  return { ok: true };
}

export function getTenantPersonaRaw(tenantId) {
  return getDb().prepare('SELECT * FROM tenant_persona WHERE tenant_id = ?').get(tenantId) || null;
}

/** Сбросить кэш персон (для тестов/после правок). */
export function clearPersonaCache() {
  cache.clear();
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

  // База знаний: факты, на которые секретарь опирается (не выдумывает сверх неё)
  if (persona.facts_md && persona.facts_md.trim()) {
    parts.push(
      'БАЗА ЗНАНИЙ (опирайся на эти факты; если ответа здесь нет — честно скажи, что уточнишь у владельца):\n' +
      renderTemplate(persona.facts_md, persona.vars)
    );
  }

  const disclose = persona.disclosure[surface] !== false;
  parts.push(renderTemplate(
    disclose ? persona.disclosure_text.on : persona.disclosure_text.off,
    persona.vars
  ));

  return parts.join('\n\n');
}
