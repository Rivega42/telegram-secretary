/**
 * stt.js — транскрипция голосовых сообщений (опционально)
 *
 * Включается, если задан STT_BASE_URL (OpenAI-совместимый /v1/audio/transcriptions:
 * OpenAI Whisper API, LiteLLM, локальный faster-whisper-server и т.п.).
 * Не настроено — голосовые, как раньше, эскалируются владельцу.
 *
 * Поток: getFile (Telegram) → скачать → POST multipart → текст.
 * Без новых зависимостей: FormData/Blob/fetch встроены в Node ≥ 18.
 */

const STT_TIMEOUT_MS = parseInt(process.env.STT_TIMEOUT_MS || '60000', 10);
const MAX_VOICE_BYTES = 20 * 1024 * 1024; // лимит Telegram getFile

export function isSttConfigured() {
  return !!process.env.STT_BASE_URL;
}

/**
 * Транскрибировать voice/audio из business_message.
 * Возвращает { ok, text } либо { ok: false, error }.
 */
export async function transcribeVoice(msg) {
  if (!isSttConfigured()) return { ok: false, error: 'STT not configured' };

  const token = process.env.BUSINESS_BOT_TOKEN;
  const voice = msg.voice || msg.audio || msg.video_note;
  if (!token || !voice?.file_id) return { ok: false, error: 'no voice file' };
  if (voice.file_size && voice.file_size > MAX_VOICE_BYTES) {
    return { ok: false, error: 'voice file too large' };
  }

  try {
    // 1. путь к файлу
    const fileResp = await fetch(`https://api.telegram.org/bot${token}/getFile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
      body: JSON.stringify({ file_id: voice.file_id })
    });
    const fileData = await fileResp.json();
    if (!fileData.ok) return { ok: false, error: fileData.description || 'getFile failed' };

    // 2. скачать
    const audioResp = await fetch(
      `https://api.telegram.org/file/bot${token}/${fileData.result.file_path}`,
      { signal: AbortSignal.timeout(STT_TIMEOUT_MS) }
    );
    if (!audioResp.ok) return { ok: false, error: `download failed: ${audioResp.status}` };
    const audio = await audioResp.blob();

    // 3. транскрипция
    const form = new FormData();
    const filename = fileData.result.file_path.split('/').pop() || 'voice.oga';
    form.append('file', audio, filename);
    form.append('model', process.env.STT_MODEL || 'whisper-1');

    const sttResp = await fetch(
      `${process.env.STT_BASE_URL.replace(/\/$/, '')}/v1/audio/transcriptions`,
      {
        method: 'POST',
        headers: process.env.STT_API_KEY ? { 'Authorization': `Bearer ${process.env.STT_API_KEY}` } : {},
        signal: AbortSignal.timeout(STT_TIMEOUT_MS),
        body: form
      }
    );
    const sttData = await sttResp.json();
    if (!sttData.text) return { ok: false, error: sttData.error?.message || 'empty transcription' };

    return { ok: true, text: sttData.text.trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
