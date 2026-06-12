/**
 * llm-http.js — общий клиент OpenAI-совместимого chat/completions API
 * для всех драйверов мозга. Таймаут — LLM_TIMEOUT_MS (по умолчанию 45 с).
 */

const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '45000', 10);

export async function chatCompletions(instance, { messages, maxTokens = 300, extraBody = {}, extraHeaders = {} }) {
  if (!instance.api_key) {
    return { ok: false, error: `API key not configured for instance "${instance.name || '?'}"` };
  }
  try {
    const r = await fetch(`${String(instance.base_url).replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${instance.api_key}`,
        ...extraHeaders
      },
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      body: JSON.stringify({
        model: instance.model,
        max_tokens: maxTokens,
        messages,
        ...extraBody
      })
    });
    const d = await r.json();
    if (d.error) {
      return { ok: false, error: d.error.message || JSON.stringify(d.error) };
    }
    const text = d.choices?.[0]?.message?.content;
    if (!text) {
      return { ok: false, error: 'empty completion' };
    }
    return { ok: true, text, model: d.model, usage: d.usage };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
