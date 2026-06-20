/**
 * Тесты шифрования секретов арендаторов at-rest.
 * Изолированный STATE_DIR + включённый SECRETS_KEY.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync('/tmp/secretary-test-secrets-');
process.env.STATE_DIR = TMP;
process.env.SECRETS_KEY = 'unit-test-master-key';

const { encryptSecret, decryptSecret, blindIndex, isEncryptionEnabled } = await import('../src/core/secrets-crypto.js');
const { getDb } = await import('../src/core/db.js');
const { seedDefaultTenant, createTenant, setTenantSecret, getTenantSecret,
        resolveTenantByWebhookSecret } = await import('../src/core/tenant.js');

seedDefaultTenant();

test('encrypt/decrypt: round-trip и недетерминированность', () => {
  assert.equal(isEncryptionEnabled(), true);
  const enc = encryptSecret('123:botToken');
  assert.match(enc, /^v1\./);
  assert.notEqual(enc, '123:botToken');             // не плейн
  assert.notEqual(enc, encryptSecret('123:botToken')); // разный IV → разный шифртекст
  assert.equal(decryptSecret(enc), '123:botToken');
});

test('decrypt: легаси-плейн (без префикса) возвращается как есть', () => {
  assert.equal(decryptSecret('plain-legacy'), 'plain-legacy');
});

test('blindIndex: детерминирован и не равен значению', () => {
  assert.equal(blindIndex('abc'), blindIndex('abc'));
  assert.notEqual(blindIndex('abc'), 'abc');
});

test('setTenantSecret: в БД значение зашифровано, чтение прозрачно', () => {
  createTenant({ id: 'sec1', plan: 'pro' });
  setTenantSecret('sec1', 'tg_bot_token', '999:secret');
  // чтение через API — расшифровано
  assert.equal(getTenantSecret('sec1', 'tg_bot_token'), '999:secret');
  // на диске (в строке БД) — не плейн
  const raw = getDb().prepare("SELECT value FROM tenant_secrets WHERE tenant_id='sec1' AND key='tg_bot_token'").get();
  assert.match(raw.value, /^v1\./);
  assert.ok(!raw.value.includes('999:secret'));
});

test('resolveTenantByWebhookSecret: поиск по слепому индексу при шифровании', () => {
  createTenant({ id: 'sec2', plan: 'free' });
  setTenantSecret('sec2', 'tg_webhook_secret', 'whsec-xyz');
  // value зашифрован, но резолв работает через blind index
  assert.equal(resolveTenantByWebhookSecret('whsec-xyz').id, 'sec2');
  assert.equal(resolveTenantByWebhookSecret('нет'), null);
  // в БД lookup — это HMAC, не сам секрет
  const raw = getDb().prepare("SELECT value, lookup FROM tenant_secrets WHERE tenant_id='sec2' AND key='tg_webhook_secret'").get();
  assert.ok(!raw.value.includes('whsec-xyz'));
  assert.equal(raw.lookup, blindIndex('whsec-xyz'));
  assert.ok(!raw.lookup.includes('whsec-xyz'));
});

test('миграция: легаси-плейн строки читаются и резолвятся (lookup бэкфилл)', () => {
  // Эмулируем строку из ранней S5 (до шифрования): плейн value, lookup NULL
  const db = getDb();
  createTenant({ id: 'legacy1', plan: 'free' });
  db.prepare("INSERT OR REPLACE INTO tenant_secrets (tenant_id, key, value, lookup) VALUES ('legacy1','tg_webhook_secret','legacy-plain',NULL)").run();
  // легаси-фоллбек по value
  assert.equal(resolveTenantByWebhookSecret('legacy-plain').id, 'legacy1');
  // чтение плейна тоже работает
  assert.equal(getTenantSecret('legacy1', 'tg_webhook_secret'), 'legacy-plain');
});
