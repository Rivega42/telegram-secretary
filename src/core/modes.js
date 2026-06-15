/**
 * modes.js — режимы секретаря per-tenant (control plane)
 *
 * Хранится в таблице tenant_settings (по арендатору): { mode, draft }.
 *   mode:  auto | off | vacation
 *   draft: true → ответ уходит только после подтверждения владельца
 *
 * Управляется командами боту уведомлений: /on /off /vacation /draft /status.
 * Старый глобальный mode.json мигрируется в арендатора default при первом чтении.
 */

import fs from 'fs';
import path from 'path';
import { getDb } from './db.js';
import { currentTenantId, DEFAULT_TENANT } from './context.js';

const STATE_DIR = process.env.STATE_DIR || './state';
const MODE_FILE = path.join(STATE_DIR, 'mode.json');

export const MODES = ['auto', 'off', 'vacation'];
export const VACATION_DELAY_SECONDS = parseInt(process.env.VACATION_DELAY_SECONDS || '20', 10);

const DEFAULTS = { mode: 'auto', draft: false };
let migratedModeJson = false;

/**
 * Одноразовая миграция глобального mode.json → арендатор default.
 */
function migrateModeJsonOnce(db) {
  if (migratedModeJson) return;
  migratedModeJson = true;
  try {
    if (fs.existsSync(MODE_FILE) && !db.prepare('SELECT 1 FROM tenant_settings WHERE tenant_id = ?').get(DEFAULT_TENANT)) {
      const data = JSON.parse(fs.readFileSync(MODE_FILE, 'utf-8'));
      db.prepare('INSERT OR REPLACE INTO tenant_settings (tenant_id, data) VALUES (?, ?)')
        .run(DEFAULT_TENANT, JSON.stringify({ mode: data.mode || 'auto', draft: !!data.draft }));
      fs.renameSync(MODE_FILE, `${MODE_FILE}.migrated`);
      console.log('[Modes] mode.json мигрирован в арендатора default');
    }
  } catch (err) {
    console.error('[Modes] Ошибка миграции mode.json:', err.message);
  }
}

export function getSettings() {
  const db = getDb();
  migrateModeJsonOnce(db);
  const row = db.prepare('SELECT data FROM tenant_settings WHERE tenant_id = ?').get(currentTenantId());
  if (!row) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(row.data) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(settings) {
  getDb().prepare('INSERT OR REPLACE INTO tenant_settings (tenant_id, data) VALUES (?, ?)')
    .run(currentTenantId(), JSON.stringify(settings));
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
