/**
 * stats.js — агрегаты для дайджеста и метрик (из SQLite, без новых хранилищ)
 *
 * Считает по таблицам history и persons. Платформа выводится из префикса
 * thread_id: vk- / wa- / lead- / иначе telegram-личка.
 */

import { getDb } from './db.js';
import { currentTenantId } from './context.js';

export function platformOf(threadId) {
  const t = String(threadId);
  if (t.startsWith('vk-')) return 'vk';
  if (t.startsWith('wa-')) return 'whatsapp';
  if (t.startsWith('lead-')) return 'lead';
  return 'telegram';
}

/**
 * Сводка за окно (по умолчанию сутки).
 * Возвращает: объём сообщений по ролям, активные диалоги, разбивку по платформам,
 * персоны (всего/новые/по политикам).
 */
export function computeStats({ sinceMs = 24 * 60 * 60 * 1000 } = {}) {
  const db = getDb();
  const cutoff = new Date(Date.now() - sinceMs).toISOString();

  const tenant = currentTenantId();
  const rows = db.prepare('SELECT thread_id, role FROM history WHERE tenant_id = ? AND ts >= ?').all(tenant, cutoff);
  const byRole = { client: 0, vika: 0, owner: 0 };
  const byPlatform = {};
  const threads = new Set();

  for (const r of rows) {
    byRole[r.role] = (byRole[r.role] || 0) + 1;
    threads.add(r.thread_id);
    const p = platformOf(r.thread_id);
    byPlatform[p] = byPlatform[p] || { incoming: 0, secretary: 0 };
    if (r.role === 'client') byPlatform[p].incoming++;
    else if (r.role === 'vika') byPlatform[p].secretary++;
  }

  const persons = db.prepare('SELECT data FROM persons WHERE tenant_id = ?').all(tenant).map(x => JSON.parse(x.data));
  const byPolicy = {};
  let newPersons = 0;
  for (const p of persons) {
    byPolicy[p.policy] = (byPolicy[p.policy] || 0) + 1;
    if (p.created_at && p.created_at >= cutoff) newPersons++;
  }

  return {
    window_hours: Math.round(sinceMs / 3600000),
    messages: { incoming: byRole.client, secretary: byRole.vika, owner: byRole.owner },
    active_conversations: threads.size,
    by_platform: byPlatform,
    persons: { total: persons.length, new: newPersons, by_policy: byPolicy }
  };
}
