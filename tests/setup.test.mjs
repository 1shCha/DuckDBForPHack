import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DuckDBInstance } from '@duckdb/node-api';
import { createDatabaseService } from '../dist/database-service.js';
import { createApp } from '../dist/app.js';

const key = 'test-only-secret-that-is-at-least-32-characters';

test('setup mode starts without a file, rejects data, and recovers after atomic upload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duckdb-api-setup-'));
  const path = join(directory, 'commercial_clean.duckdb');
  let service;
  let server;
  try {
    await assert.rejects(createDatabaseService(undefined, true), /DUCKDB_PATH/);
    await assert.rejects(createDatabaseService(path, false), /ENOENT/);
    service = await createDatabaseService(path, true);
    server = createApp(service, key).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.equal((await fetch(base + '/health/db')).status, 503);
    const response = await fetch(base + '/properties/1', { headers: { 'X-API-Key': key } });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Database is not ready' });
    assert.equal((await fetch(base + '/properties/1')).status, 401);

    const uploaded = join(directory, 'database.upload');
    const instance = await DuckDBInstance.create(uploaded);
    const connection = await instance.connect();
    await connection.run('CREATE TABLE property_coverage AS SELECT 1::BIGINT AS property_id');
    connection.closeSync();
    instance.closeSync();
    await rename(uploaded, path);
    const healthy = await fetch(base + '/health/db');
    assert.equal(healthy.status, 200);
    assert.deepEqual(await healthy.json(), { status: 'ok', database: 'ok' });
    assert.deepEqual(await service.query('SELECT property_id FROM property_coverage'), [{ property_id: '1' }]);
    await assert.rejects(service.query('CREATE TABLE forbidden (id INTEGER)'), /read.only/i);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    service?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
