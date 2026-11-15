import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createApp } from '../dist/app.js';

const key = 'test-only-secret-that-is-at-least-32-characters';

test('API protects data, validates inputs, paginates, and contains errors', async () => {
  const calls = [];
  let fail = false;
  const database = {
    check: async () => { if (fail) throw new Error('private database details'); },
    close: () => {},
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (fail) throw new Error('private database details');
      if (values[0] !== 1) return [];
      if (sql.includes('FROM properties p')) return [{ property_id: '1' }];
      return [{ evidence_id: 'a' }, { evidence_id: 'b' }, { evidence_id: 'c' }].slice(values[2], values[2] + values[1]);
    },
  };
  assert.throws(() => createApp(database, ''), /API_KEY/);
  const server = createApp(database, key).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, authenticated = true) => fetch(base + path, {
    headers: authenticated ? { 'X-API-Key': key } : {},
  });
  try {
    assert.equal((await get('/health', false)).status, 200);
    assert.equal((await get('/properties/1', false)).status, 401);
    const wrong = await fetch(base + '/properties/1', { headers: { 'X-API-Key': 'wrong' } });
    assert.equal(wrong.status, 401);
    assert.equal(calls.length, 0);
    for (const path of ['/properties/1%20OR%201=1', '/properties/0', '/properties/9007199254740992', '/properties/1/tenants?limit=101', '/properties/1/tenants?limit=1&limit=2', '/properties/1/deals?offset=-1', '/properties/1?sql=select']) {
      assert.equal((await get(path)).status, 400, path);
    }
    assert.equal(calls.length, 0);
    assert.equal((await get('/properties/2')).status, 404);
    const property = await get('/properties/1');
    assert.deepEqual(await property.json(), { data: { property_id: '1' } });
    for (const kind of ['tenants', 'deals']) {
      const response = await get(`/properties/1/${kind}?limit=2`);
      const body = await response.json();
      assert.equal(body.data.length, 2);
      assert.deepEqual(body.pagination, { limit: 2, offset: 0, has_more: true, next_offset: 2 });
      assert.deepEqual(calls.at(-1).values, [1, 3, 0]);
      const last = await (await get(`/properties/1/${kind}?limit=2&offset=2`)).json();
      assert.equal(last.data.length, 1);
      assert.equal(last.pagination.next_offset, null);
    }
    fail = true;
    assert.equal((await get('/health/db')).status, 503);
    const failed = await get('/properties/1');
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: 'Unable to retrieve data' });
    fail = false;
    let limited = false;
    for (let i = 0; i < 121; i++) {
      const response = await get('/properties/1');
      if (response.status === 429) { limited = true; break; }
    }
    assert.equal(limited, true);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
