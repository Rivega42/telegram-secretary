/**
 * identity.js — слой персон поверх SQLite: память ведётся по людям,
 * а не по платформенным ID
 *
 * Таблицы (см. core/db.js): persons (данные), person_identities
 * (platform+platform_user_id → person_id, O(1)-резолв).
 *
 * Правила (docs/openclaw-integration.md, раздел 3):
 * - один человек = одна персона, платформенные identity прикрепляются к ней
 * - автоматическая склейка персон между платформами ЗАПРЕЩЕНА —
 *   слияние только по подтверждению владельца (mergePersons вызывается явно)
 */

import { getDb } from './db.js';

export const POLICIES = ['auto', 'escalate', 'ignore'];

function rowToPerson(row) {
  return { id: row.id, ...JSON.parse(row.data) };
}

function savePerson(db, id, person) {
  const { id: _omit, isNew: _omit2, ...data } = person;
  db.prepare('INSERT OR REPLACE INTO persons (id, data) VALUES (?, ?)')
    .run(id, JSON.stringify(data));
}

function nextSeq(db) {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'persons_seq'`).get();
  const seq = (row ? parseInt(row.value, 10) : 0) + 1;
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('persons_seq', ?)`).run(String(seq));
  return seq;
}

/**
 * Найти персону по платформенному ID или создать новую.
 * Возвращает { id, isNew, ...person }.
 */
export function resolvePerson({ platform, platformUserId, displayName = '', username = null }) {
  const db = getDb();
  const id = String(platformUserId);

  const link = db.prepare(
    'SELECT person_id FROM person_identities WHERE platform = ? AND platform_user_id = ?'
  ).get(platform, id);

  if (link) {
    const person = rowToPerson(db.prepare('SELECT id, data FROM persons WHERE id = ?').get(link.person_id));
    person.last_seen = new Date().toISOString();
    if (displayName) person.display_name = displayName;
    if (username) person.username = username;
    savePerson(db, person.id, person);
    return { ...person, isNew: false };
  }

  const tx = db.transaction(() => {
    const personId = `person-${String(nextSeq(db)).padStart(4, '0')}`;
    const person = {
      identities: { [platform]: id },
      display_name: displayName,
      username,
      policy: 'auto',
      created_at: new Date().toISOString(),
      last_seen: new Date().toISOString()
    };
    savePerson(db, personId, person);
    db.prepare('INSERT INTO person_identities (platform, platform_user_id, person_id) VALUES (?, ?, ?)')
      .run(platform, id, personId);
    return { id: personId, isNew: true, ...person };
  });
  return tx();
}

export function getPerson(personId) {
  const row = getDb().prepare('SELECT id, data FROM persons WHERE id = ?').get(personId);
  return row ? rowToPerson(row) : null;
}

export function getPersons() {
  const rows = getDb().prepare('SELECT id, data FROM persons').all();
  return Object.fromEntries(rows.map(r => [r.id, rowToPerson(r)]));
}

export function setPersonPolicy(personId, policy) {
  if (!POLICIES.includes(policy)) {
    return { ok: false, error: `policy must be one of: ${POLICIES.join(', ')}` };
  }
  const person = getPerson(personId);
  if (!person) {
    return { ok: false, error: `person not found: ${personId}` };
  }
  person.policy = policy;
  savePerson(getDb(), personId, person);
  return { ok: true, person: { ...person, id: personId } };
}

/**
 * Кандидаты на склейку с person: совпадение username или непустого
 * display_name у персоны БЕЗ identity на этой платформе.
 * Только подсказка владельцу — само слияние всегда явное (mergePersons).
 */
export function findSimilarPersons(person) {
  const username = (person.username || '').toLowerCase();
  const displayName = (person.display_name || '').trim().toLowerCase();
  const platforms = Object.keys(person.identities || {});
  const result = [];

  for (const [id, p] of Object.entries(getPersons())) {
    if (id === person.id) continue;
    // уже есть identity на той же платформе — это другой человек, не предлагать
    if (platforms.some(pl => p.identities?.[pl])) continue;
    const sameUsername = username && (p.username || '').toLowerCase() === username;
    const sameName = displayName && (p.display_name || '').trim().toLowerCase() === displayName;
    if (sameUsername || sameName) {
      result.push({ ...p, id, match: sameUsername ? 'username' : 'name' });
    }
  }
  return result;
}

/**
 * Слить две персоны (identities переносятся в target, source удаляется).
 * Вызывается ТОЛЬКО по явному подтверждению владельца — автоматическая
 * склейка запрещена дизайном.
 */
export function mergePersons(targetId, sourceId) {
  const db = getDb();
  const target = getPerson(targetId);
  const source = getPerson(sourceId);
  if (!target || !source) {
    return { ok: false, error: 'person not found' };
  }
  for (const [platform, pid] of Object.entries(source.identities || {})) {
    if (target.identities[platform] && target.identities[platform] !== pid) {
      return { ok: false, error: `identity conflict on platform "${platform}"` };
    }
  }

  const tx = db.transaction(() => {
    for (const [platform, pid] of Object.entries(source.identities || {})) {
      target.identities[platform] = pid;
      db.prepare('UPDATE person_identities SET person_id = ? WHERE platform = ? AND platform_user_id = ?')
        .run(targetId, platform, String(pid));
    }
    savePerson(db, targetId, target);
    db.prepare('DELETE FROM persons WHERE id = ?').run(sourceId);
    return { ok: true, person: { ...target, id: targetId } };
  });
  return tx();
}
