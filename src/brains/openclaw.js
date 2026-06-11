/**
 * openclaw.js — драйвер для OpenClaw-инстанса: сессии агента per-person,
 * единая память в workspace инстанса.
 *
 * Отличия от stateless-llm:
 * - в запрос передаётся `user: <person_id>` (стандартное поле OpenAI API) и
 *   заголовок сессии (по умолчанию `x-openclaw-session-id`), чтобы инстанс
 *   вёл отдельную сессию на каждого человека;
 * - при `stateful: true` (по умолчанию) локальная история НЕ передаётся —
 *   контекст и память ведёт сам агент в своём workspace;
 * - при `send_system: false` системный промпт не передаётся — персона агента
 *   настраивается на стороне OpenClaw, чтобы не конфликтовать.
 *
 * Настройки инстанса (instances.json):
 *   { "driver": "openclaw", "base_url": ..., "api_key": "${GW_API_KEY}",
 *     "model": "openclaw", "stateful": true, "send_system": true,
 *     "session_header": "x-openclaw-session-id", "session_prefix": "secretary" }
 *
 * Точное имя session-заголовка зависит от версии OpenClaw Gateway —
 * оно вынесено в конфиг, чтобы не зашивать протокол в код.
 */

import { chatCompletions } from './llm-http.js';
import { buildSystemPrompt } from '../core/persona.js';
import { buildUserPrompt } from '../core/prompt.js';

export async function respond(envelope, ctx, instance) {
  const { persona, person, history = [], isFirstTime = true, rewrite = null } = ctx;

  const stateful = instance.stateful !== false;
  const sendSystem = instance.send_system !== false;
  const sessionHeader = instance.session_header || 'x-openclaw-session-id';
  const sessionPrefix = instance.session_prefix || 'secretary';
  const personId = person?.id || `anon:${envelope.identity.platform_user_id}`;
  const sessionId = `${sessionPrefix}:${personId}`;

  const messages = [];
  if (sendSystem) {
    messages.push({ role: 'system', content: buildSystemPrompt(persona, envelope.surface) });
  }
  messages.push({
    role: 'user',
    content: buildUserPrompt(envelope, {
      // stateful-агент сам помнит диалог — историю не дублируем
      history: stateful ? [] : history,
      persona,
      isFirstTime,
      rewrite
    })
  });

  const result = await chatCompletions(instance, {
    messages,
    maxTokens: instance.max_tokens || 300,
    extraBody: { user: personId },
    extraHeaders: { [sessionHeader]: sessionId }
  });
  if (!result.ok) {
    console.error(`[Brain:openclaw] ${instance.name} (session ${sessionId}): ${result.error}`);
  }
  return { ...result, session_id: sessionId };
}
