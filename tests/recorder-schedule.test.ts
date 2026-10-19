import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recorderEntries,recentRecorderFiles} from '../lib/recorder-schedule';
import type {RecorderDirectory,RecorderFileHandle} from '../lib/recorder-browser';
import {monitorFresh} from '../lib/account-state';
const now=Date.parse('2026-10-19T16:00:00Z');
const file=(name:string)=>({kind:'file' as const,name,getFile:async()=>({name})as File});
function folder(){
 let enumerations=0;const lookups:string[]=[],files=Array.from({length:300},(_,i)=>file('archived-'+i+'.xml'));
 const handle:RecorderDirectory={kind:'directory',name:'accounts-v2',queryPermission:async()=>'granted',requestPermission:async()=>'granted',async *values(){enumerations++;yield* files;},getFileHandle:async name=>{lookups.push(name);if(name==='account-state.tradebook.xml'||name.endsWith('.accounts.tradebook.xml'))return file(name);throw new DOMException('Missing','NotFoundError');}};
 return {handle,lookups,enumerations:()=>enumerations};
}
async function collect(iterator:AsyncIterable<RecorderFileHandle|{kind:'directory';name:string}>){const result=[];for await(const entry of iterator)result.push(entry.name);return result;}
test('routine scans check only the account snapshot and recent daily files instead of enumerating archives',async()=>{
 const f=folder(),result=await collect(recorderEntries(f.handle,false,now));assert.equal(f.enumerations(),0);assert.equal(f.lookups.length,5);assert.equal(result.length,3);assert.ok(result.includes('2026-10-19.accounts.tradebook.xml'));assert.ok(result.includes('2026-10-18.accounts.tradebook.xml'));
});
test('full discovery and older handle fallbacks retain access to every archive',async()=>{
 const f=folder();assert.equal((await collect(recorderEntries(f.handle,true,now))).length,300);assert.equal(f.lookups.length,0);assert.equal(f.enumerations(),1);
 delete f.handle.getFileHandle;assert.equal((await collect(recorderEntries(f.handle,false,now))).length,300);
});
test('recent-file discovery rolls at Central midnight and permission failures remain visible',async()=>{
 assert.ok(recentRecorderFiles(Date.parse('2026-10-20T04:59:00Z')).includes('2026-10-19.accounts.tradebook.xml'));
 const midnight=recentRecorderFiles(Date.parse('2026-10-20T05:00:00Z'));assert.ok(midnight.includes('2026-10-20.accounts.tradebook.xml'));assert.ok(midnight.includes('2026-10-19.accounts.tradebook.xml'));
 const f=folder();f.handle.getFileHandle=async()=>{throw new DOMException('Permission needed','NotAllowedError');};await assert.rejects(()=>collect(recorderEntries(f.handle,false,now)),{name:'NotAllowedError'});
});
test('light recorder freshness allows minute snapshots plus browser delay without changing the legacy cutoff',()=>{
 const monitor={capturedAt:new Date(now).toISOString(),running:true,recorderVersion:'0.4.0',scopePrefixes:['LFE'],accountsSeen:[]};
 assert.equal(monitorFresh(monitor,now+120000),true);assert.equal(monitorFresh(monitor,now+180001),false);assert.equal(monitorFresh({...monitor,recorderVersion:'0.3.0'},now+90001),false);assert.equal(monitorFresh({...monitor,running:false},now),false);
});
