/**
 * stateless-llm.js — драйвер «из коробки»: любой OpenAI-совместимый endpoint,
 * память — локальная история диалога, передаётся в промпте.
 *
 * Это fallback-режим шаблона без OpenClaw; сохраняется навсегда
 * (см. docs/openclaw-integration.md).
 */

import { chatCompletions } from './llm-http.js';
import { buildSystemPrompt } from '../core/persona.js';

const HISTORY_LIMIT_CHARS = 12000;

function historyLabel(from, persona) {
  if (from === 'client') return '👤 Клиент';
  if (from === 'owner') return `👨‍💼 ${persona.vars.owner_name} (владелец)`;
  return `💁 ${persona.vars.secretary_name}`;
}

/**
 * Пользовательский промпт: контекст отправителя + история (хронологически,
 * старые → новые — инвариант проекта) + текущее сообщение.
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
    // history приходит из state.js уже в хронологическом порядке — не реверсить
    for (const m of history) {
      const time = m.ts
        ? new Date(m.ts).toLocaleString('ru-RU', { timeZone: process.env.TZ_DISPLAY || 'Europe/Moscow', hour: '2-digit', minute: '2-digit' })
        : '??:??';
      block += `[${time}] ${historyLabel(m.from, persona)}: ${m.text}\n`;
    }
    if (block.length > HISTORY_LIMIT_CHARS) {
      block = '…(начало истории опущено)…\n' + block.slice(-HISTORY_LIMIT_CHARS);
    }
    p += block + '---\n\n';
  }
  p += `📩 ТЕКУЩЕЕ СООБЩЕНИЕ ОТ КЛИЕНТА:\n${envelope.text}`;
  return p;
}

export async function respond(envelope, ctx, instance) {
  const { persona, history = [], isFirstTime = true } = ctx;
  const result = await chatCompletions(instance, {
    messages: [
      { role: 'system', content: buildSystemPrompt(persona, envelope.surface) },
      { role: 'user', content: buildUserPrompt(envelope, { history, persona, isFirstTime }) }
    ],
    maxTokens: instance.max_tokens || 300
  });
  if (!result.ok) {
    console.error(`[Brain:stateless-llm] ${instance.name}: ${result.error}`);
  }
  return result;
}
