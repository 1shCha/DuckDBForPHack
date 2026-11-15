import assert from 'node:assert/strict';
import {test} from 'node:test';
import {once} from 'node:events';
import {createApp} from '../dist/app.js';

const key='tools-test-key-with-at-least-32-characters';
test('fixed tools require authentication, validate bodies, and release parser-error slots',async()=>{
 const db={check:async()=>{},close:()=>{},query:async(sql)=>sql.includes('count(*)')?[{total:0}]:[]};
 const server=createApp(db,key).listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}/tools/`;
 async function post(name,input,expected=400,auth=true){
  const r=await fetch(base+name,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-API-Key':key}:{})},body:JSON.stringify(input)});
  assert.equal(r.status,expected,name);return r;
 }
 try{
  for(const name of ['find_properties','find_suites','get_tenant_history','get_spatial_context','database_health'])await post(name,{},401,false);
  for(const [name,input] of [
   ['find_properties',{query:'x',sql:'SELECT 1'}],['find_properties',{query:'x'.repeat(301)}],
   ['find_properties',{query:'x',limit:101}],['find_suites',{property_id:'1; DROP TABLE properties'}],
   ['find_suites',{property_id:'1',offset:100001}],['get_tenant_history',{suite_id:'invalid'}],
   ['get_spatial_context',{property_id:'1',suite_id:'invalid'}],['database_health',{sql:'SELECT 1'}],
  ])await post(name,input);
  await post('query',{sql:'SELECT 1'},404);
  await post('constructor',{},404);
  for(let i=0;i<5;i++){
   const r=await fetch(base+'find_properties',{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':key},body:'bad-json'});assert.equal(r.status,400);
  }
  await post('find_properties',{query:'x'.repeat(17000)},413);
  const good=await post('find_properties',{query:'No matching property'},200);
  assert.deepEqual(await good.json(),{items:[],total:0,limit:20,offset:0});
 }finally{await new Promise(resolve=>server.close(resolve));}
});
