/**
 * stateless-llm.js — драйвер «из коробки»: любой OpenAI-совместимый endpoint,
 * память — локальная история диалога, передаётся в промпте.
 *
 * Это fallback-режим шаблона без OpenClaw; сохраняется навсегда
 * (см. docs/openclaw-integration.md).
 */

import { chatCompletions } from './llm-http.js';
import { buildSystemPrompt } from '../core/persona.js';
import { buildUserPrompt } from '../core/prompt.js';

export async function respond(envelope, ctx, instance) {
  const { persona, history = [], isFirstTime = true, rewrite = null } = ctx;
  const result = await chatCompletions(instance, {
    messages: [
      { role: 'system', content: buildSystemPrompt(persona, envelope.surface) },
      { role: 'user', content: buildUserPrompt(envelope, { history, persona, isFirstTime, rewrite }) }
    ],
    maxTokens: instance.max_tokens || 300
  });
  if (!result.ok) {
    console.error(`[Brain:stateless-llm] ${instance.name}: ${result.error}`);
  }
  return result;
}
