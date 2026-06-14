/**
 * digest.js — дайджест владельцу: сводка за период текстом в бота уведомлений
 *
 * Ежедневно в DIGEST_TIME (МСК, напр. "21:00"; пусто — выключено) + команда /digest.
 * Данные — из core/stats.js (history/persons) + живые счётчики очереди и черновиков.
 */

import { computeStats } from '../../core/stats.js';
import { feedbackStats } from '../../core/feedback.js';
import { getAllPending } from '../../scheduler.js';
import { getAllDrafts } from '../../core/drafts.js';
import { notifyOwnerText } from '../../forward.js';

const PLATFORM_LABELS = {
  telegram: 'Telegram',
  vk: 'ВКонтакте',
  whatsapp: 'WhatsApp',
  lead: 'Лиды (бот)'
};

/**
 * Текст дайджеста за окно (часы).
 */
export function buildDigestText(windowHours = 24) {
  const stats = computeStats({ sinceMs: windowHours * 3600000 });
  const pending = Object.keys(getAllPending()).length;
  const drafts = Object.keys(getAllDrafts()).length;
  const m = stats.messages;

  const lines = [
    `📊 Дайджест за ${windowHours} ч`,
    '',
    `💬 Сообщений: ${m.incoming} вход · ${m.secretary} ответил секретарь · ${m.owner} ответил ты`,
    `🗂 Активных диалогов: ${stats.active_conversations}`,
    `👥 Контактов всего: ${stats.persons.total} (новых за период: ${stats.persons.new})`
  ];

  const platforms = Object.entries(stats.by_platform)
    .filter(([, v]) => v.incoming || v.secretary)
    .map(([k, v]) => `   • ${PLATFORM_LABELS[k] || k}: ${v.incoming}→${v.secretary}`);
  if (platforms.length) lines.push('📡 По платформам (вход→ответ):', ...platforms);

  const pol = stats.persons.by_policy;
  if (pol.escalate || pol.ignore) {
    lines.push(`🛡 Политики: ${pol.escalate || 0} только мне · ${pol.ignore || 0} игнор`);
  }

  const fb = feedbackStats(windowHours * 3600000);
  if (fb.corrections || fb.likes || fb.dislikes) {
    lines.push(`📈 Качество: 👍 ${fb.likes} · 👎 ${fb.dislikes} · правок ${fb.corrections}`);
  }

  if (pending) lines.push(`⏳ Ждут автоответа: ${pending}`);
  if (drafts) lines.push(`📝 Черновиков на подтверждение: ${drafts}`);

  if (!m.incoming && !m.secretary && !m.owner) {
    lines.push('', 'Тихо — входящих не было.');
  }
  return lines.join('\n');
}

export async function sendDigest(windowHours = 24) {
  return notifyOwnerText(buildDigestText(windowHours));
}

/**
 * Планировщик ежедневного дайджеста (минутный тик, как у автопостинга).
 */
export function startDigestSchedule() {
  const time = (process.env.DIGEST_TIME || '').trim();
  if (!time) return { stop: () => {} };

  console.log(`[Digest] Ежедневный дайджест в ${time} МСК`);
  let firedDay = null;

  const tick = async () => {
    const now = new Date();
    const msk = now.toLocaleString('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false });
    const today = now.toISOString().split('T')[0];
    if (msk === time && firedDay !== today) {
      firedDay = today;
      try { await sendDigest(24); } catch (err) { console.error('[Digest] Ошибка:', err); }
    }
  };

  const handle = setInterval(tick, 60 * 1000);
  handle.unref();
  return { stop: () => clearInterval(handle) };
}
