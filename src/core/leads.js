/**
 * leads.js — лиды и их статусы + выгрузка во внешнюю CRM
 *
 * Раньше лид был только уведомлением «🔥 Лид», которое уезжало вверх. Теперь
 * лид сохраняется со статусом (new/working/won/lost), владелец двигает его
 * кнопками, и при настроенном CRM_WEBHOOK_URL лид уходит во внешнюю систему
 * (Make/Zapier/Pipedrive вебхуком).
 */

import { getDb } from './db.js';

export const LEAD_STATUSES = ['new', 'working', 'won', 'lost'];

/**
 * Создать лид при первом контакте (или не трогать существующий).
 * Возвращает { lead, isNew }.
 */
export function recordLead({ personId, platform = 'telegram', source = null, displayName = '', firstMessage = '' }) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM leads WHERE person_id = ?').get(personId);
  if (existing) return { lead: existing, isNew: false };

  const now = new Date().toISOString();
  const lead = {
    person_id: personId, platform, source, display_name: displayName,
    first_message: firstMessage, status: 'new', created_at: now, updated_at: now
  };
  db.prepare(
    `INSERT INTO leads (person_id, platform, source, display_name, first_message, status, created_at, updated_at)
     VALUES (@person_id, @platform, @source, @display_name, @first_message, @status, @created_at, @updated_at)`
  ).run(lead);
  return { lead, isNew: true };
}

export function setLeadStatus(personId, status) {
  if (!LEAD_STATUSES.includes(status)) {
    return { ok: false, error: `status must be one of: ${LEAD_STATUSES.join(', ')}` };
  }
  const db = getDb();
  const info = db.prepare('UPDATE leads SET status = ?, updated_at = ? WHERE person_id = ?')
    .run(status, new Date().toISOString(), personId);
  if (!info.changes) return { ok: false, error: 'lead not found' };
  return { ok: true, lead: db.prepare('SELECT * FROM leads WHERE person_id = ?').get(personId) };
}

export function listLeads({ status = null } = {}) {
  const db = getDb();
  return status
    ? db.prepare('SELECT * FROM leads WHERE status = ? ORDER BY updated_at DESC').all(status)
    : db.prepare('SELECT * FROM leads ORDER BY updated_at DESC').all();
}

export function leadsStats(sinceMs = 24 * 60 * 60 * 1000) {
  const cutoff = new Date(Date.now() - sinceMs).toISOString();
  const db = getDb();
  const newCount = db.prepare('SELECT COUNT(*) c FROM leads WHERE created_at >= ?').get(cutoff).c;
  const byStatus = {};
  for (const r of db.prepare('SELECT status, COUNT(*) c FROM leads GROUP BY status').all()) {
    byStatus[r.status] = r.c;
  }
  return { new: newCount, by_status: byStatus };
}

/**
 * Выгрузить лид во внешнюю CRM (если задан CRM_WEBHOOK_URL). Fire-and-forget,
 * ошибки не критичны. Уважает DRY_RUN.
 */
export async function exportLeadToCrm(lead) {
  const url = process.env.CRM_WEBHOOK_URL;
  if (!url) return { ok: false, skipped: true };
  if (process.env.DRY_RUN === 'true') {
    console.log('[Leads][DRY_RUN] CRM export:', lead.person_id);
    return { ok: true, dry_run: true };
  }
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.CRM_WEBHOOK_SECRET ? { 'Authorization': `Bearer ${process.env.CRM_WEBHOOK_SECRET}` } : {})
      },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ type: 'lead', ...lead })
    });
    return { ok: r.ok, status: r.status };
  } catch (err) {
    console.error('[Leads] CRM export error:', err.message);
    return { ok: false, error: err.message };
  }
}
