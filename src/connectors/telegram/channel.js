/**
 * channel.js — автопостинг в Telegram-канал по контент-плану
 *
 * Включается, если заданы env CHANNEL_ID (id или @username канала, бот
 * уведомлений — админ канала) и POSTING_TIMES ("10:00,18:00" по МСК).
 *
 * Контент-план: STATE_DIR/content-plan.json
 *   { "topics": ["тема 1", "тема 2", ...], "next_index": 0,
 *     "posted": [{ "date", "topic", "preview" }] }
 * Темы ротируются по кругу; владелец редактирует файл руками
 * (или просит секретаря через /post <тема>).
 *
 * Прямой публикации НЕТ: пост всегда приходит владельцу черновиком
 * «📤 Опубликовать / 🔄 Переписать / 🗑 Отбросить» (принцип публичных
 * поверхностей). /post [тема] — сгенерировать вне расписания.
 */

import fs from 'fs';
import path from 'path';
import { createEnvelope } from '../../core/envelope.js';
import { respond as brainRespond } from '../../core/brain.js';
import { loadPersona } from '../../core/persona.js';
import { saveDraft } from '../../core/drafts.js';
import { truncate } from '../../core/format.js';
import { notifyOwnerText } from '../../forward.js';

const STATE_DIR = process.env.STATE_DIR || './state';
const PLAN_FILE = path.join(STATE_DIR, 'content-plan.json');

const DEFAULT_PLAN = {
  topics: [],
  next_index: 0,
  posted: []
};

export function loadPlan() {
  try {
    if (fs.existsSync(PLAN_FILE)) {
      return { ...DEFAULT_PLAN, ...JSON.parse(fs.readFileSync(PLAN_FILE, 'utf-8')) };
    }
  } catch (err) {
    console.error('[Channel] Ошибка чтения content-plan.json:', err.message);
  }
  return { ...DEFAULT_PLAN };
}

export function savePlan(plan) {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2), 'utf-8');
}

/**
 * Следующая тема из плана (ротация по кругу). null — план пуст.
 */
export function nextTopic() {
  const plan = loadPlan();
  if (!plan.topics.length) return null;
  const topic = plan.topics[plan.next_index % plan.topics.length];
  plan.next_index = (plan.next_index + 1) % plan.topics.length;
  savePlan(plan);
  return topic;
}

export function recordPosted(topic, text) {
  const plan = loadPlan();
  plan.posted.push({ date: new Date().toISOString(), topic, preview: truncate(text, 100) });
  if (plan.posted.length > 200) plan.posted = plan.posted.slice(-200);
  savePlan(plan);
}

/**
 * Сгенерировать пост и положить черновик владельцу.
 * topic не задан — берётся из контент-плана.
 */
export async function generatePost(topic = null) {
  const channelId = process.env.CHANNEL_ID;
  if (!channelId) {
    return { ok: false, error: 'CHANNEL_ID не задан — автопостинг выключен' };
  }

  const theme = topic || nextTopic();
  if (!theme) {
    await notifyOwnerText('📋 Контент-план пуст. Добавь темы в content-plan.json или используй /post <тема>.');
    return { ok: false, error: 'content plan empty' };
  }

  const persona = loadPersona();
  const recent = loadPlan().posted.slice(-5).map(p => `- ${p.topic}: ${p.preview}`).join('\n');

  const envelope = createEnvelope({
    platform: 'telegram',
    surface: 'channel_post',
    identity: { platform_user_id: 'channel', display_name: 'канал владельца' },
    threadKey: `telegram:channel_post:${channelId}`,
    text:
      `Напиши пост для Telegram-канала владельца на тему: «${theme}».\n` +
      (recent ? `\nПоследние посты (не повторяйся):\n${recent}\n` : '') +
      `\nТребования: цепляющий первый абзац, по делу, без воды, до 800 знаков, ` +
      `уместные эмодзи, в конце — лёгкий призыв к обсуждению в комментариях.`,
    raw: { channel_id: channelId }
  });

  const brainResult = await brainRespond(envelope, { persona, history: [], isFirstTime: true });
  if (!brainResult.ok && !brainResult.text) {
    await notifyOwnerText(`⚠️ Не удалось сгенерировать пост на тему «${theme}»: ${brainResult.error}`);
    return { ok: false, error: brainResult.error };
  }

  const draftKey = `post:${Date.now()}`;
  saveDraft(draftKey, {
    kind: 'channel',
    text: brainResult.text,
    chat_id: channelId,
    topic: theme,
    envelope // для «🔄 Переписать» (regenerate с комментарием владельца)
  });

  await notifyOwnerText(
    `📰 Черновик поста (тема: «${theme}»):\n\n${brainResult.text}`,
    {
      buttons: [[
        { text: '📤 Опубликовать', callback_data: `draft:ok:${draftKey}` },
        { text: '🔄 Переписать', callback_data: `draft:rw:${draftKey}` },
        { text: '🗑 Отбросить', callback_data: `draft:no:${draftKey}` }
      ]]
    }
  );
  return { ok: true, draftKey, topic: theme };
}

/**
 * Планировщик: раз в минуту сверяет время (МСК) с POSTING_TIMES;
 * каждый слот срабатывает не чаще раза в сутки.
 */
export function startPostingSchedule() {
  const channelId = process.env.CHANNEL_ID;
  const times = (process.env.POSTING_TIMES || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!channelId || !times.length) return { stop: () => {} };

  console.log(`[Channel] Автопостинг включён: ${times.join(', ')} МСК → ${channelId} (через черновик владельцу)`);
  const firedToday = new Map(); // "HH:MM" → "YYYY-MM-DD"

  const tick = async () => {
    const now = new Date();
    const msk = now.toLocaleString('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false });
    const today = now.toISOString().split('T')[0];
    if (times.includes(msk) && firedToday.get(msk) !== today) {
      firedToday.set(msk, today);
      try {
        await generatePost();
      } catch (err) {
        console.error('[Channel] Ошибка генерации поста:', err);
      }
    }
  };

  const handle = setInterval(tick, 60 * 1000);
  handle.unref();
  return { stop: () => clearInterval(handle) };
}
