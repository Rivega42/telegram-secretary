/**
 * Тесты лид-CRM: статусы, идемпотентность, выгрузка, интеграция с воронкой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TMP = fs.mkdtempSync('/tmp/secretary-test-leads-');
process.env.STATE_DIR = TMP;
process.env.PERSONA_DIR = './persona';
process.env.DRY_RUN = 'true';
process.env.DRY_RUN_BRAIN = 'true';
process.env.OWNER_CHAT_ID = '1';
process.env.ONEINT_BOT_TOKEN = 'dummy';

const { recordLead, setLeadStatus, listLeads, leadsStats, exportLeadToCrm, LEAD_STATUSES } =
  await import('../src/core/leads.js');
const { handleLeadMessage } = await import('../src/connectors/telegram/community.js');

test('recordLead: создаёт лид, повтор не дублирует', () => {
  const a = recordLead({ personId: 'person-1', source: 'post_42', firstMessage: 'привет' });
  assert.equal(a.isNew, true);
  assert.equal(a.lead.status, 'new');
  const b = recordLead({ personId: 'person-1', firstMessage: 'снова' });
  assert.equal(b.isNew, false); // тот же лид
});

test('setLeadStatus: валидные переходы, невалидный отклоняется', () => {
  assert.equal(setLeadStatus('person-1', 'working').ok, true);
  assert.equal(listLeads({ status: 'working' }).length, 1);
  assert.equal(setLeadStatus('person-1', 'won').ok, true);
  assert.equal(setLeadStatus('person-1', 'nonsense').ok, false);
  assert.equal(setLeadStatus('missing', 'won').ok, false);
  assert.deepEqual(LEAD_STATUSES, ['new', 'working', 'won', 'lost']);
});

test('leadsStats: новые за окно и разбивка по статусам', () => {
  recordLead({ personId: 'person-2', firstMessage: 'ещё лид' });
  const s = leadsStats(24 * 3600000);
  assert.ok(s.new >= 2);
  assert.ok(s.by_status.won >= 1);
  assert.ok(s.by_status.new >= 1);
});

test('exportLeadToCrm: без URL — skipped; в DRY_RUN — ok без сети', async () => {
  delete process.env.CRM_WEBHOOK_URL;
  assert.equal((await exportLeadToCrm({ person_id: 'x' })).skipped, true);
  process.env.CRM_WEBHOOK_URL = 'https://example.com/hook';
  assert.equal((await exportLeadToCrm({ person_id: 'x' })).dry_run, true);
  delete process.env.CRM_WEBHOOK_URL;
});

test('воронка: handleLeadMessage создаёт лид со статусом new', async () => {
  const before = listLeads().length;
  await handleLeadMessage({
    chat: { id: 999, type: 'private' },
    from: { id: 999, username: 'lead9', first_name: 'Лид9' },
    text: '/start post_77'
  });
  const leads = listLeads();
  assert.equal(leads.length, before + 1);
  const lead = leads.find(l => l.source === 'post_77');
  assert.ok(lead);
  assert.equal(lead.status, 'new');
});
