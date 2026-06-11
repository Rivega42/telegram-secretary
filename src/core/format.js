/**
 * format.js — мелкие общие форматтеры для уведомлений и логов
 */

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
