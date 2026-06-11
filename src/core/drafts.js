/**
 * drafts.js — черновики ответов в draft-режиме
 *
 * drafts.json в STATE_DIR: mappingId → {
 *   text,            — сгенерированный ответ
 *   envelope,        — конверт исходного сообщения (для отправки/регенерации)
 *   person_id,
 *   original_text,   — что спрашивал клиент
 *   created_at
 * }
 *
 * Черновик не имеет авто-таймаута: без подтверждения владельца ничего
 * не уходит клиенту (принцип draft-режима).
 */

import fs from 'fs';
import path from 'path';

const STATE_DIR = process.env.STATE_DIR || './state';
const DRAFTS_FILE = path.join(STATE_DIR, 'drafts.json');

function load() {
  try {
    if (fs.existsSync(DRAFTS_FILE)) {
      return JSON.parse(fs.readFileSync(DRAFTS_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('[Drafts] Error loading drafts.json:', err.message);
  }
  return {};
}

function save(drafts) {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(DRAFTS_FILE, JSON.stringify(drafts, null, 2), 'utf-8');
}

export function saveDraft(mappingId, draft) {
  const drafts = load();
  drafts[mappingId] = { ...draft, created_at: new Date().toISOString() };
  save(drafts);
  return drafts[mappingId];
}

export function getDraft(mappingId) {
  return load()[mappingId] || null;
}

export function deleteDraft(mappingId) {
  const drafts = load();
  if (!drafts[mappingId]) return false;
  delete drafts[mappingId];
  save(drafts);
  return true;
}

export function getAllDrafts() {
  return load();
}
