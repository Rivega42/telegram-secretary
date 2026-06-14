/**
 * feedback.js — петля качества: сохранение правок владельца и оценок ответов
 *
 * Правки (когда владелец нажимает «🔄 Переписать» и диктует, как поправить) —
 * ценнейший обучающий сигнал. Раньше выбрасывались; теперь копятся в SQLite
 * и подмешиваются как few-shot в будущие промпты (FEEDBACK_FEWSHOT).
 * Лайк/дизлайк под копией ответа — субъективная оценка качества.
 */

import { getDb } from './db.js';

const FEWSHOT_LIMIT = parseInt(process.env.FEEDBACK_FEWSHOT_LIMIT || '2', 10);
const FEWSHOT_ENABLED = process.env.FEEDBACK_FEWSHOT !== 'false';

/**
 * Сохранить правку: владелец показал, как должен был выглядеть ответ.
 */
export function recordCorrection({ surface = 'dm', personId = null, original = '', note = '', corrected = '' }) {
  getDb().prepare(
    `INSERT INTO feedback (ts, kind, surface, person_id, original, note, corrected)
     VALUES (?, 'correction', ?, ?, ?, ?, ?)`
  ).run(new Date().toISOString(), surface, personId, original, note, corrected);
}

/**
 * Сохранить оценку ответа (+1 / -1).
 */
export function recordRating({ surface = 'dm', personId = null, original = '', rating }) {
  getDb().prepare(
    `INSERT INTO feedback (ts, kind, surface, person_id, original, rating)
     VALUES (?, 'rating', ?, ?, ?, ?)`
  ).run(new Date().toISOString(), surface, personId, original, rating > 0 ? 1 : -1);
}

/**
 * Последние правки для поверхности — для few-shot в промпте.
 */
export function recentCorrections(surface = 'dm', limit = FEWSHOT_LIMIT) {
  if (!FEWSHOT_ENABLED || limit <= 0) return [];
  return getDb().prepare(
    `SELECT note, corrected FROM feedback
     WHERE kind = 'correction' AND surface = ? AND corrected <> ''
     ORDER BY id DESC LIMIT ?`
  ).all(surface, limit).reverse();
}

/**
 * Сводка обратной связи за окно — для дайджеста.
 */
export function feedbackStats(sinceMs = 24 * 60 * 60 * 1000) {
  const cutoff = new Date(Date.now() - sinceMs).toISOString();
  const rows = getDb().prepare(
    `SELECT kind, rating FROM feedback WHERE ts >= ?`
  ).all(cutoff);
  let corrections = 0, likes = 0, dislikes = 0;
  for (const r of rows) {
    if (r.kind === 'correction') corrections++;
    else if (r.kind === 'rating') (r.rating > 0 ? likes++ : dislikes++);
  }
  return { corrections, likes, dislikes };
}
