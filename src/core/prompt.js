/**
 * prompt.js — общий построитель пользовательского промпта для драйверов мозга
 *
 * Контракт: история приходит из state.js хронологически (старые → новые)
 * и передаётся в том же порядке — не реверсить (инвариант проекта).
 */

const HISTORY_LIMIT_CHARS = 12000;

function displayTime(ts) {
  const tz = process.env.TZ_DISPLAY || 'Europe/Moscow';
  return ts
    ? new Date(ts).toLocaleString('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' })
    : '??:??';
}

export function historyLabel(from, persona) {
  if (from === 'client') return '👤 Клиент';
  if (from === 'owner') return `👨‍💼 ${persona.vars.owner_name} (владелец)`;
  return `💁 ${persona.vars.secretary_name}`;
}

/**
 * Контекст отправителя + история + текущее сообщение.
 */
export function buildUserPrompt(envelope, { history = [], persona, isFirstTime = true }) {
  const now = new Date().toLocaleString('ru-RU', { timeZone: process.env.TZ_DISPLAY || 'Europe/Moscow' });
  let p = `⏰ СЕЙЧАС: ${now}

👤 КОНТЕКСТ ОТПРАВИТЕЛЯ:
- Имя: ${envelope.identity.display_name || 'Неизвестно'}
- Username: ${envelope.identity.username ? '@' + envelope.identity.username : '(нет)'}
- Платформа/поверхность: ${envelope.platform} / ${envelope.surface}
- Всего сообщений в истории: ${history.length}
- Это ${isFirstTime ? 'первый' : 'повторный'} разговор
`;
  if (history.length) {
    p += `\n📋 ИСТОРИЯ ПЕРЕПИСКИ (от старых к новым):\n`;
    let block = '';
    for (const m of history) {
      block += `[${displayTime(m.ts)}] ${historyLabel(m.from, persona)}: ${m.text}\n`;
    }
    if (block.length > HISTORY_LIMIT_CHARS) {
      block = '…(начало истории опущено)…\n' + block.slice(-HISTORY_LIMIT_CHARS);
    }
    p += block + '---\n\n';
  }
  p += `📩 ТЕКУЩЕЕ СООБЩЕНИЕ ОТ КЛИЕНТА:\n${envelope.text}`;
  return p;
}
