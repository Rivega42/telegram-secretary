/**
 * secrets-crypto.js — шифрование секретов арендаторов at-rest (SaaS)
 *
 * AES-256-GCM поверх ключа из env `SECRETS_KEY` (любая строка → sha256 → 32 байта).
 * Прозрачно: если ключ не задан — значения хранятся как есть (обратная
 * совместимость с single-owner и ранними записями S5).
 *
 * Формат шифртекста: `v1.<iv_b64>.<tag_b64>.<ct_b64>`. Легаси-плейн (без
 * префикса) читается как есть — миграция «лениво», при следующей записи.
 *
 * Поисковые секреты (напр. секрет вебхука) индексируются «слепым индексом»
 * (HMAC-SHA256) — детерминированный поиск без раскрытия значения в БД.
 */

import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const PREFIX = 'v1.';

function deriveKey(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest();
}

/** Строка основного ключа (которым шифруем сейчас). */
function primaryKeyStr() {
  return process.env.SECRETS_KEY || process.env.SECRET_ENCRYPTION_KEY || '';
}

/** Старые ключи (через запятую в SECRETS_KEYS_OLD) — для дешифровки в окне ротации. */
function oldKeyStrs() {
  return (process.env.SECRETS_KEYS_OLD || '').split(',').map(s => s.trim()).filter(Boolean);
}

/** 32-байтный основной ключ или null, если шифрование выключено. */
function rawKey() {
  const k = primaryKeyStr();
  return k ? deriveKey(k) : null;
}

/** Все ключи (основной + старые) для попыток дешифровки. */
function allKeys() {
  return [primaryKeyStr(), ...oldKeyStrs()].filter(Boolean).map(deriveKey);
}

export function isEncryptionEnabled() {
  return !!primaryKeyStr();
}

/** Зашифровать значение (или вернуть как есть, если ключ не задан). */
export function encryptSecret(plain) {
  const key = rawKey();
  if (!key) return String(plain);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ct].map(b => b.toString('base64')).join('.');
}

/** Расшифровать; легаси-плейн (без префикса) возвращается как есть. Пробуем
 *  основной ключ, затем старые (окно ротации) — нужный определяется по auth-тегу GCM. */
export function decryptSecret(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) return stored;
  const keys = allKeys();
  if (!keys.length) throw new Error('SECRETS_KEY не задан, а значение зашифровано');
  const [, ivB, tagB, ctB] = stored.split('.');
  const iv = Buffer.from(ivB, 'base64'), tag = Buffer.from(tagB, 'base64'), ct = Buffer.from(ctB, 'base64');
  for (const key of keys) {
    try {
      const decipher = crypto.createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch { /* не тот ключ — пробуем следующий */ }
  }
  throw new Error('ни один из ключей (SECRETS_KEY/SECRETS_KEYS_OLD) не подошёл');
}

/**
 * Слепой индекс для поиска по значению без его раскрытия. С ключом — HMAC
 * на основном ключе, без ключа — само значение (легаси-поиск по плейну).
 */
export function blindIndex(plain) {
  const key = rawKey();
  if (!key) return String(plain);
  return crypto.createHmac('sha256', key).update(String(plain), 'utf8').digest('hex');
}

/**
 * Кандидаты слепого индекса для резолва в окне ротации: индексы по всем ключам
 * + плейн-фоллбек (для строк, записанных до включения шифрования).
 */
export function blindIndexCandidates(plain) {
  const out = new Set([String(plain)]);
  for (const key of allKeys()) {
    out.add(crypto.createHmac('sha256', key).update(String(plain), 'utf8').digest('hex'));
  }
  return [...out];
}
