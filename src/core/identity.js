/**
 * identity.js — слой персон: память ведётся по людям, а не по платформенным ID
 *
 * persons.json в STATE_DIR:
 * {
 *   "seq": 2,
 *   "persons": {
 *     "person-0001": {
 *       "identities": { "telegram": "357896330" },
 *       "display_name": "...", "username": "...",
 *       "policy": "auto" | "escalate" | "ignore",
 *       "created_at": "...", "last_seen": "..."
 *     }
 *   }
 * }
 *
 * Правила (docs/openclaw-integration.md, раздел 3):
 * - один человек = одна персона, платформенные identity прикрепляются к ней
 * - автоматическая склейка персон между платформами ЗАПРЕЩЕНА —
 *   слияние только по подтверждению владельца (mergePersons вызывается явно)
 */

import fs from 'fs';
import path from 'path';

const STATE_DIR = process.env.STATE_DIR || './state';
const PERSONS_FILE = path.join(STATE_DIR, 'persons.json');

export const POLICIES = ['auto', 'escalate', 'ignore'];

function load() {
  try {
    if (fs.existsSync(PERSONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PERSONS_FILE, 'utf-8'));
      if (data && typeof data.persons === 'object') return data;
    }
  } catch (err) {
    console.error('[Identity] Error loading persons.json:', err.message);
  }
  return { seq: 0, persons: {} };
}

function save(data) {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PERSONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function findByIdentity(data, platform, platformUserId) {
  const id = String(platformUserId);
  for (const [personId, person] of Object.entries(data.persons)) {
    if (person.identities && String(person.identities[platform]) === id) {
      return { personId, person };
    }
  }
  return null;
}

/**
 * Найти персону по платформенному ID или создать новую.
 * Возвращает { id, isNew, ...person }.
 */
export function resolvePerson({ platform, platformUserId, displayName = '', username = null }) {
  const data = load();
  const existing = findByIdentity(data, platform, platformUserId);

  if (existing) {
    const { personId, person } = existing;
    person.last_seen = new Date().toISOString();
    if (displayName) person.display_name = displayName;
    if (username) person.username = username;
    save(data);
    return { id: personId, isNew: false, ...person };
  }

  data.seq += 1;
  const personId = `person-${String(data.seq).padStart(4, '0')}`;
  const person = {
    identities: { [platform]: String(platformUserId) },
    display_name: displayName,
    username,
    policy: 'auto',
    created_at: new Date().toISOString(),
    last_seen: new Date().toISOString()
  };
  data.persons[personId] = person;
  save(data);
  return { id: personId, isNew: true, ...person };
}

export function getPerson(personId) {
  const data = load();
  const person = data.persons[personId];
  return person ? { id: personId, ...person } : null;
}

export function getPersons() {
  const data = load();
  return Object.fromEntries(
    Object.entries(data.persons).map(([id, p]) => [id, { id, ...p }])
  );
}

export function setPersonPolicy(personId, policy) {
  if (!POLICIES.includes(policy)) {
    return { ok: false, error: `policy must be one of: ${POLICIES.join(', ')}` };
  }
  const data = load();
  if (!data.persons[personId]) {
    return { ok: false, error: `person not found: ${personId}` };
  }
  data.persons[personId].policy = policy;
  save(data);
  return { ok: true, person: { id: personId, ...data.persons[personId] } };
}

/**
 * Слить две персоны (identities переносятся в target, source удаляется).
 * Вызывается ТОЛЬКО по явному подтверждению владельца — автоматическая
 * склейка запрещена дизайном.
 */
export function mergePersons(targetId, sourceId) {
  const data = load();
  const target = data.persons[targetId];
  const source = data.persons[sourceId];
  if (!target || !source) {
    return { ok: false, error: 'person not found' };
  }
  for (const [platform, pid] of Object.entries(source.identities || {})) {
    if (target.identities[platform] && target.identities[platform] !== pid) {
      return { ok: false, error: `identity conflict on platform "${platform}"` };
    }
    target.identities[platform] = pid;
  }
  delete data.persons[sourceId];
  save(data);
  return { ok: true, person: { id: targetId, ...target } };
}
