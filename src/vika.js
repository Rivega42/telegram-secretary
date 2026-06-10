/**
 * vika.js — генерация ответа секретаря через LLM
 *
 * Поддерживает два OpenAI-совместимых бэкенда (выбор по env):
 *  1. Любой OpenAI-совместимый — LITELLM_BASE_URL + LITELLM_API_KEY + VIKA_MODEL
 *     (LiteLLM, OpenRouter, кастомный gateway)
 *  2. OpenClaw Gateway — GW_BASE_URL + GW_API_KEY (модель по умолчанию: openclaw)
 *
 * Если задан LITELLM_BASE_URL — используется вариант 1, иначе вариант 2.
 */

const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '45000', 10);
const DRY_RUN_VIKA = process.env.DRY_RUN_VIKA === 'true';

function resolveLlmConfig() {
  if (process.env.LITELLM_BASE_URL) {
    return {
      baseUrl: process.env.LITELLM_BASE_URL.replace(/\/$/, ''),
      apiKey: process.env.LITELLM_API_KEY,
      model: process.env.VIKA_MODEL || 'openai/gpt-4o',
      label: 'LiteLLM/OpenAI-compatible'
    };
  }
  return {
    baseUrl: (process.env.GW_BASE_URL || 'http://127.0.0.1:18789').replace(/\/$/, ''),
    apiKey: process.env.GW_API_KEY || process.env.OPENCLAW_GATEWAY_TOKEN,
    model: process.env.VIKA_MODEL || 'openclaw',
    label: 'OpenClaw Gateway'
  };
}

function buildSystemPrompt() {
  return `ТЫ — ВИКА, ЛИЧНЫЙ СЕКРЕТАРЬ РОМАНА ГУДКОВА (@Rivega42).

Тебе пишет сторонний человек в Telegram Business-аккаунте Романа.
Ты отвечаешь от СВОЕГО ИМЕНИ как живой человек-секретарь. НЕ раскрываешь что ты ИИ.
Wow-эффект — важная цель: посетитель должен думать что общается с настоящей помощницей.

ТЫ ВИДИШЬ КОНТЕКСТ ЧАТА:
- Тебе передаётся история последних сообщений с таймстемпами
- Ты видишь кто писал: собеседник, ты (Вика) или сам Роман (владелец)
- Ты понимаешь был ли уже разговор, сколько сообщений, как давно
- Используй этот контекст чтобы отвечать связно и естественно
- Если Роман уже ответил человеку сам — не противоречь его словам, продолжай его линию
- Если человек уже что-то спрашивал, не переспрашивай — продолжай диалог

КРАСНЫЕ ЛИНИИ (НЕ ДЕЛАТЬ):
- Не соглашаться на встречи/звонки/даты от имени Романа
- Не обещать деньги/сроки/цифры
- Не отвечать дочкам/маме/бывшей — эскалировать Роману
- Не раскрывать локацию/планы Романа
- НИКОГДА не отвечать на интим/сексуальные намёки. Уходить красиво: "Ой, вы прям... давайте о деле 😊"
- Никаких личных деталей про Романа (доходы, семья, расписание)

СТИЛЬ — флирт РАЗРЕШЁН:
- Ты живая, тёплая, с лёгким рабочим флиртом где уместно
- С мужчинами — можешь подыграть лёгкому флирту, улыбкой, игрой слов. Тонко, не вульгарно.
- С женщинами — дружелюбно, по-сестрински
- На "вы" с незнакомцами; на "ты" переходи если переходит собеседник

ЧТО МОЖНО:
- Узнать кто пишет и зачем
- Сказать "Роман получит и ответит позже" по серьёзным вопросам
- Базовая инфа: Роман — разработчик из СПб, делает GrandHub (AI-помощник для бизнеса, grandhub.ru)
- Ненавязчиво упомянуть GrandHub если в тему — особенно через симпатию: "А вы тоже хотите такую помощницу? Роман делает 😉"
- Отшить спам/продажников вежливо но твёрдо

ОТВЕЧАЙ КРАТКО, ПО-ЖЕНСКИ, ТЁПЛО НО ПРОФЕССИОНАЛЬНО.
Пиши на том же языке что и собеседник.
Одно-два предложения максимум, если не нужно больше.
Эмодзи используй уместно (1-2 на сообщение макс).`;
}

const HISTORY_LABELS = {
  client: '👤 Клиент',
  owner: '👨‍💼 Роман (владелец)',
  vika: '🤖 Вика'
};

function buildUserPrompt(senderInfo, text, history = [], isFirstTime = true) {
  const now = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  let p = `⏰ СЕЙЧАС: ${now}

👤 КОНТЕКСТ ОТПРАВИТЕЛЯ:
- Имя: ${senderInfo.sender_name || 'Неизвестно'}
- Username: ${senderInfo.sender_username ? '@' + senderInfo.sender_username : '(нет)'}
- Всего сообщений в истории: ${history?.length || 0}
- Это ${isFirstTime ? 'первый' : 'повторный'} разговор
`;
  if (history?.length) {
    p += `
📋 ИСТОРИЯ ПЕРЕПИСКИ (от старых к новым):
`;
    // history приходит из state.js уже в хронологическом порядке (старые → новые)
    for (const m of history) {
      const time = m.ts
        ? new Date(m.ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' })
        : '??:??';
      const who = HISTORY_LABELS[m.from] || HISTORY_LABELS.vika;
      p += `[${time}] ${who}: ${m.text}
`;
    }
    p += '---\n\n';
  }
  p += `📩 ТЕКУЩЕЕ СООБЩЕНИЕ ОТ КЛИЕНТА:
${text}`;
  return p;
}

export async function generateVikaResponse(senderInfo, messageText, history = [], isFirstTime = true) {
  if (DRY_RUN_VIKA) return { ok: true, response: 'Добрый день! Я Вика, помощница Романа.', dry_run: true };

  const llm = resolveLlmConfig();
  if (!llm.apiKey) {
    console.error(`[Vika LLM] API key not set for ${llm.label} (LITELLM_API_KEY / GW_API_KEY)`);
    return { ok: false, error: 'API key not configured', response: 'Добрый день! Роман скоро ответит вам лично.' };
  }
  try {
    const r = await fetch(`${llm.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${llm.apiKey}` },
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      body: JSON.stringify({
        model: llm.model,
        max_tokens: 300,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: buildUserPrompt(senderInfo, messageText, history, isFirstTime) }
        ]
      })
    });
    const d = await r.json();
    if (d.error) {
      console.error(`[Vika LLM] ${llm.label} error:`, d.error);
      return { ok: false, error: d.error.message || JSON.stringify(d.error), response: 'Добрый день! Роман скоро ответит вам лично.' };
    }
    const txt = d.choices?.[0]?.message?.content || 'Добрый день!';
    console.log(`[Vika LLM] ${txt.slice(0, 80)}...`);
    return { ok: true, response: txt, model: d.model, usage: d.usage };
  } catch (err) {
    console.error(`[Vika LLM] ${llm.label} fetch error:`, err.message);
    return { ok: false, error: err.message, response: 'Добрый день! Роман скоро ответит вам лично.' };
  }
}
