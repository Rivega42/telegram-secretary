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

/** 32-байтный ключ из env или null, если шифрование выключено. */
function rawKey() {
  const k = process.env.SECRETS_KEY || process.env.SECRET_ENCRYPTION_KEY || '';
  return k ? crypto.createHash('sha256').update(k, 'utf8').digest() : null;
}

export function isEncryptionEnabled() {
  return !!rawKey();
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

/** Расшифровать; легаси-плейн (без префикса) возвращается как есть. */
export function decryptSecret(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) return stored;
  const key = rawKey();
  if (!key) throw new Error('SECRETS_KEY не задан, а значение зашифровано');
  const [, ivB, tagB, ctB] = stored.split('.');
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * Слепой индекс для поиска по значению без его раскрытия. С ключом — HMAC,
 * без ключа — само значение (легаси-поиск по плейну остаётся рабочим).
 */
export function blindIndex(plain) {
  const key = rawKey();
  if (!key) return String(plain);
  return crypto.createHmac('sha256', key).update(String(plain), 'utf8').digest('hex');
}
