/**
 * modes.js — глобальные режимы секретаря (control plane)
 *
 * mode.json в STATE_DIR:
 *   { "mode": "auto" | "off" | "vacation", "draft": false }
 *
 * mode:
 *   auto     — обычная работа: отложенный автоответ
 *   off      — «я свободен»: только уведомления владельцу, без автоответов
 *   vacation — «отпуск»: отвечать почти сразу (короткая задержка)
 * draft:
 *   true — ответы не уходят клиенту сразу: черновик владельцу на подтверждение
 *
 * Управляется командами боту уведомлений: /on /off /vacation /draft /status
 * (см. connectors/telegram/control.js) — переживает рестарт.
 */

import fs from 'fs';
import path from 'path';

const STATE_DIR = process.env.STATE_DIR || './state';
const MODE_FILE = path.join(STATE_DIR, 'mode.json');

export const MODES = ['auto', 'off', 'vacation'];

// Задержка в режиме «отпуск», сек (чуть-чуть «человечности» вместо мгновенного ответа)
export const VACATION_DELAY_SECONDS = parseInt(process.env.VACATION_DELAY_SECONDS || '20', 10);

const DEFAULTS = { mode: 'auto', draft: false };

export function getSettings() {
  try {
    if (fs.existsSync(MODE_FILE)) {
      const data = JSON.parse(fs.readFileSync(MODE_FILE, 'utf-8'));
      return { ...DEFAULTS, ...data };
    }
  } catch (err) {
    console.error('[Modes] Error loading mode.json:', err.message);
  }
  return { ...DEFAULTS };
}

function save(settings) {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(MODE_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

export function setMode(mode) {
  if (!MODES.includes(mode)) {
    return { ok: false, error: `mode must be one of: ${MODES.join(', ')}` };
  }
  const settings = { ...getSettings(), mode, updated_at: new Date().toISOString() };
  save(settings);
  return { ok: true, settings };
}

export function setDraft(draft) {
  const settings = { ...getSettings(), draft: !!draft, updated_at: new Date().toISOString() };
  save(settings);
  return { ok: true, settings };
}
