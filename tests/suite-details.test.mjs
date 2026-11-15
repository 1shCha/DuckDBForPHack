import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSuiteDetailTools} from '../dist/suite-detail-tools.js';

function recorder(rows = []) {
  const calls = [];
  const tools = createSuiteDetailTools(async (sql, values) => { calls.push({sql, values}); return rows; });
  return {calls, tools};
}

test('building tenants and rent comps bind the property id to fixed queries', async () => {
  const {calls, tools} = recorder();
  await tools.get_building_tenants({property_id: '238587'});
  assert.deepEqual(calls[0].values, ['238587']);
  await tools.get_rent_comps({property_id: '238587'});
  assert.deepEqual(calls[1].values, ['238587']);
  assert.deepEqual(calls[2].values, ['238587', '238587', 2, 2, 2]);
  for (const bad of [{}, {property_id: 238587}, {property_id: '0'}, {property_id: "1 OR 1=1"}, {property_id: '1'.repeat(30)}]) {
    await assert.rejects(tools.get_building_tenants(bad));
    await assert.rejects(tools.get_rent_comps(bad));
  }
  await assert.rejects(tools.get_rent_comps({property_id: '1', radius_miles: 0}));
  await assert.rejects(tools.get_rent_comps({property_id: '1', radius_miles: 50}));
});

test('tenant lists are capped at 100 and say so', async () => {
  const {tools} = recorder(Array.from({length: 101}, (_, i) => ({company_name: `C${i}`})));
  const result = await tools.get_building_tenants({property_id: '5'});
  assert.equal(result.tenants.length, 100);
  assert.equal(result.truncated, true);
});

test('expiring leases validate location, industries and size, and never put text in the SQL', async () => {
  const {calls, tools} = recorder();
  await tools.find_expiring_leases({latitude: 29.7, longitude: -95.4, industries: ["Legal' OR 1=1 --"], sqft_min: 3000, sqft_max: 5000});
  assert.ok(!calls[0].sql.includes('Legal'));
  assert.deepEqual(calls[0].values.slice(7, 13), ["Legal' OR 1=1 --", "Legal' OR 1=1 --", 3000, 3000, 5000, 5000]);
  assert.equal(calls[0].values.at(-1), 5);
  for (const bad of [
    {longitude: -95.4}, {latitude: 91, longitude: 0}, {latitude: 29.7, longitude: 'x'},
    {latitude: 29.7, longitude: -95.4, industries: 'Legal'}, {latitude: 29.7, longitude: -95.4, industries: Array(11).fill('a')},
    {latitude: 29.7, longitude: -95.4, sqft_min: 5000, sqft_max: 1000}, {latitude: 29.7, longitude: -95.4, radius_miles: 100},
  ]) await assert.rejects(tools.find_expiring_leases(bad));
});
