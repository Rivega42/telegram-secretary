/**
 * Тесты реестра инстансов: env-подстановка, маршрутизация, fallback из env.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync('/tmp/secretary-test-instances-');
process.env.STATE_DIR = TMP;
process.env.TEST_GW_KEY = 'secret-from-env';
delete process.env.LITELLM_BASE_URL;
delete process.env.BRAIN_DRIVER;

const { loadInstances, getInstanceFor } = await import('../src/core/instances.js');

test('без instances.json: дефолтный инстанс синтезируется из env', () => {
  const config = loadInstances({ force: true });
  assert.ok(config.instances.default);
  assert.equal(config.routing.default, 'default');
  const inst = getInstanceFor('telegram:dm');
  assert.equal(inst.driver, 'stateless-llm');
});

test('instances.json: ${VAR} подставляется, секрет не хранится в файле', () => {
  fs.writeFileSync(path.join(TMP, 'instances.json'), JSON.stringify({
    instances: {
      main: { driver: 'openclaw', base_url: 'http://gw:18789', api_key: '${TEST_GW_KEY}', model: 'openclaw' },
      cheap: { driver: 'stateless-llm', base_url: 'http://llm:4000', api_key: 'k', model: 'gpt-4o-mini' }
    },
    routing: { 'telegram:dm': 'main', comments: 'cheap' }
  }));

  loadInstances({ force: true });
  const main = getInstanceFor('telegram:dm');
  assert.equal(main.api_key, 'secret-from-env');
  assert.equal(main.driver, 'openclaw');
});

test('маршрутизация: точный ключ → surface → default', () => {
  loadInstances({ force: true });
  assert.equal(getInstanceFor('telegram:dm').name, 'main');       // точный ключ
  assert.equal(getInstanceFor('vk:comments').name, 'cheap');      // по surface
  assert.equal(getInstanceFor('vk:group').name, 'main');          // default = первый инстанс
});

test('битый instances.json: fallback на env, не падение', () => {
  fs.writeFileSync(path.join(TMP, 'instances.json'), '{broken');
  const config = loadInstances({ force: true });
  assert.ok(config.instances.default);
});
