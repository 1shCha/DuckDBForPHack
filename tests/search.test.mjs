import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSearchCandidates} from '../dist/search-candidates.js';

test('search candidate bounds are validated and values are bound to a fixed query',async()=>{
 const calls=[];
 const search=createSearchCandidates(async(sql,values)=>{calls.push({sql,values});return[];});
 await search({sqft_min:1500,sqft_max:2000,city:'Houston'});
 assert.deepEqual(calls[0].values,[1275,2300,'Houston','Houston']);
 await search({city:"Houston' OR 1=1 --"});
 assert.ok(!calls[1].sql.includes("Houston'"));
 assert.equal(calls[1].values[2],"Houston' OR 1=1 --");
 for(const input of [{sqft_min:-1},{sqft_max:Infinity},{sqft_min:'1500'},{sqft_min:2000,sqft_max:1000},{city:{}},{city:''}])await assert.rejects(search(input));
 const large=createSearchCandidates(async()=>Array.from({length:10001},()=>({})));
 await assert.rejects(large({}),/too broad/);
});
