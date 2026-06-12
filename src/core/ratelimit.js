/**
 * ratelimit.js — скользящее окно для публичных поверхностей
 *
 * Защита от выжигания токенов: лимит ответов на человека и на чат.
 * In-memory (сбрасывается при рестарте — для защиты от спама этого достаточно).
 */

const WINDOW_MS = parseInt(process.env.RATELIMIT_WINDOW_MS || String(10 * 60 * 1000), 10);
export const LIMIT_PER_USER = parseInt(process.env.RATELIMIT_PER_USER || '3', 10);
export const LIMIT_PER_CHAT = parseInt(process.env.RATELIMIT_PER_CHAT || '10', 10);

const hits = new Map(); // key → [timestamps]

function countAndPush(key, limit) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(ts => now - ts < WINDOW_MS);
  if (arr.length >= limit) {
    hits.set(key, arr);
    return false;
  }
  arr.push(now);
  hits.set(key, arr);
  return true;
}

/**
 * Разрешён ли ответ пользователю userId в чате chatId.
 * Учитывает обе квоты атомарно: при отказе ни одна не расходуется.
 */
export function allowReply(chatId, userId) {
  const now = Date.now();
  const userKey = `u:${chatId}:${userId}`;
  const chatKey = `c:${chatId}`;

  const userArr = (hits.get(userKey) || []).filter(ts => now - ts < WINDOW_MS);
  const chatArr = (hits.get(chatKey) || []).filter(ts => now - ts < WINDOW_MS);
  hits.set(userKey, userArr);
  hits.set(chatKey, chatArr);

  if (userArr.length >= LIMIT_PER_USER || chatArr.length >= LIMIT_PER_CHAT) {
    return false;
  }
  userArr.push(now);
  chatArr.push(now);
  return true;
}

/** Для тестов */
export function resetRateLimits() {
  hits.clear();
}
