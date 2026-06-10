/**
 * vika.js — LiteLLM via http://localhost:4000 (model gpt-4o)
 */
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || 'http://localhost:4000';
const LITELLM_API_KEY = process.env.LITELLM_API_KEY;
const VIKA_MODEL = process.env.VIKA_MODEL || 'openai/gpt-4o';
const DRY_RUN_VIKA = process.env.DRY_RUN_VIKA === 'true';

function buildSystemPrompt() {
  return `ТЫ — ВИКА, ЛИЧНЫЙ СЕКРЕТАРЬ РОМАНА ГУДКОВА (@Rivega42).

Тебе пишет сторонний человек в Telegram Business-аккаунте Романа.
Ты отвечаешь от СВОЕГО ИМЕНИ как живой человек-секретарь. НЕ раскрываешь что ты ИИ.
Wow-эффект — важная цель: посетитель должен думать что общается с настоящей помощницей.

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

function buildUserPrompt(senderInfo, text, history = [], isFirstTime = true) {
  let p = `КОНТЕКСТ ОТПРАВИТЕЛЯ:\n- Имя: ${senderInfo.sender_name || 'Неизвестно'}\n- Username: ${senderInfo.sender_username ? '@' + senderInfo.sender_username : '(нет)'}\n- Это ${isFirstTime ? 'первый' : 'повторный'} разговор\n`;
  if (history?.length) {
    p += `\nПРЕДЫДУЩИЕ СООБЩЕНИЯ:\n`;
    for (const m of history.slice(-5)) {
      p += `[${m.from === 'client' ? 'Клиент' : 'Вика'}]: ${m.text}\n`;
    }
    p += '\n';
  }
  p += `ТЕКУЩЕЕ СООБЩЕНИЕ:\n${text}`;
  return p;
}

export async function generateVikaResponse(senderInfo, messageText, history = [], isFirstTime = true) {
  if (DRY_RUN_VIKA) return { ok: true, response: 'Добрый день! Я Вика, помощница Романа.', dry_run: true };
  if (!LITELLM_API_KEY) {
    console.error('LITELLM_API_KEY not set');
    return { ok: false, error: 'API key not configured', response: 'Добрый день! Роман скоро ответит вам лично.' };
  }
  try {
    const r = await fetch(`${LITELLM_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${LITELLM_API_KEY}` },
      body: JSON.stringify({
        model: VIKA_MODEL,
        max_tokens: 300,
        messages: [
          { role:'system', content: buildSystemPrompt() },
          { role:'user', content: buildUserPrompt(senderInfo, messageText, history, isFirstTime) }
        ]
      })
    });
    const d = await r.json();
    if (d.error) {
      console.error('LiteLLM API error:', d.error);
      return { ok: false, error: d.error.message || JSON.stringify(d.error), response: 'Добрый день! Роман скоро ответит вам лично.' };
    }
    const txt = d.choices?.[0]?.message?.content || 'Добрый день!';
    console.log(`[Vika LLM] ${txt.slice(0,80)}...`);
    return { ok: true, response: txt, model: d.model, usage: d.usage };
  } catch (err) {
    console.error('LiteLLM fetch error:', err.message);
    return { ok: false, error: err.message, response: 'Добрый день! Роман скоро ответит вам лично.' };
  }
}
