/**
 * format.js — мелкие общие форматтеры и утилиты
 */

import crypto from 'crypto';

/** Сравнение секретов за постоянное время (защита от timing-атак). */
export function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function truncate(text, max = 300) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max) + '...' : s;
}

/**
 * Отображение username: "@ivan" или "(no username)".
 * Принимает envelope.identity либо senderInfo.
 */
export function usernameDisplay(obj = {}) {
  const username = obj.username || obj.sender_username;
  return username ? `@${username}` : '(no username)';
}
