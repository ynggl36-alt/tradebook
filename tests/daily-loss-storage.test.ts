import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import type {Fill} from '../lib/types';
import {DAILY_LOSS_MAX_FILLS,DAILY_LOSS_MAX_BYTES,DAILY_LOSS_MAX_ROWS} from '../lib/daily-loss';

const sqlite=new DatabaseSync(':memory:');
for(const filename of fs.readdirSync('drizzle').filter(file=>file.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync('drizzle/'+filename,'utf8'));
let readonly=true;
const queries:{sql:string;parameters:unknown[]}[]=[];
class Statement{
 constructor(private sql:string,private parameters:any[]=[]){ }
 bind(...parameters:any[]){return new Statement(this.sql,parameters);}
 check(){queries.push({sql:this.sql,parameters:this.parameters});if(readonly)assert.match(this.sql.trim(),/^SELECT\b/,'The diagnostic must never update journal metadata or source records.');}
 async first(){this.check();return sqlite.prepare(this.sql).get(...this.parameters)??null;}
 async all(){this.check();return {results:sqlite.prepare(this.sql).all(...this.parameters)};}
 async run(){this.check();return {meta:{changes:sqlite.prepare(this.sql).run(...this.parameters).changes}};}
}
const database={prepare:(sql:string)=>new Statement(sql)};
const originalLoad=(Module as any)._load;
(Module as any)._load=function(name:string,...rest:any[]){return name==='cloudflare:workers'?{env:{DB:database}}:originalLoad.call(this,name,...rest);};
const {loadDailyLoss}=require('../lib/server-daily-loss')as typeof import('../lib/server-daily-loss');
const journal=require('../lib/server-journal')as typeof import('../lib/server-journal');
(Module as any)._load=originalLoad;
const start='2026-10-21',asOf=Date.parse('2026-10-22T21:00:00Z');
const request=(accounts:string[],stage='all',markedUpgradedOnly=false)=>({accounts,start,end:start,stage,markedUpgradedOnly});
function fill(id:string,side:'Buy'|'Sell',price:number,pos:number,time='2026-10-21T14:00:00Z'):Fill{return {id,contract:'NQ 2026-12',symbol:'NQ',pv:20,side,price,pos,time,qty:1,ordinal:Number(id)||1};}
function history(account:string,fills:unknown[],padding=''){
 const data=JSON.stringify({account,fills,trades:[],issues:[],...(padding?{padding}:{})});
 sqlite.prepare('INSERT INTO account_history(account,data,revision,updated,trades_data,summary_data) VALUES (?,?,1,?,\'[]\',?)').run(account,data,'2026-10-22T20:00:00Z',JSON.stringify({account,fills:fills.length,issues:[],first:start+'T14:00:00Z',last:start+'T15:00:00Z'}));
}
const changes=()=>sqlite.prepare('SELECT total_changes() AS n').get()!.n;

test('real SQL diagnostic reconstructs pre-range inventory, excludes future fills and returns summaries without writes or raw ledger fields',async()=>{
 const account='LFF05000000000101';
 history(account,[fill('1','Buy',1000,1,'2026-10-20T14:00:00Z'),fill('2','Sell',940,0),fill('3','Buy',1000,1,'2026-10-23T14:00:00Z')]);
 const before=changes();queries.length=0;
 const result=await loadDailyLoss(request([account]),asOf);
 assert.equal(queries.length,2);assert.equal(result.rows.length,1);assert.equal(result.rows[0].endNet,-1201.75);assert.equal(result.rows[0].complete,true);assert.equal(result.rows[0].fills,1);assert.equal(changes(),before);
 assert.doesNotMatch(JSON.stringify(result),/"(?:price|pv|fillId|ordinal|contract|trades|positions)":/);
 const future=await loadDailyLoss({...request([account]),end:'2026-10-24'},asOf);assert.equal(future.rows.length,1);
});
test('SQL stage filtering uses saved profiles and upgraded status without inventing pass outcomes from profitable fills',async()=>{
 const overridden='LFF05000000000102',profitable='LFE05000000000103',funded='LFF05000000000104';
 for(const account of [overridden,profitable,funded])history(account,[fill('1','Buy',1000,1),fill('2','Sell',1200,0,'2026-10-21T15:00:00Z')]);
 sqlite.prepare('INSERT INTO account_profiles(account,data) VALUES (?,?)').run(overridden,JSON.stringify({account:overridden,stage:'Evaluation',status:'Upgraded',notes:'',label:''}));
 const before=changes(),upgraded=await loadDailyLoss(request([overridden,profitable,funded],'all',true),asOf);
 assert.deepEqual(upgraded.rows.map(row=>row.account),[overridden]);assert.equal(upgraded.rows[0].markedUpgraded,true);assert.deepEqual(upgraded.excluded,[profitable,funded].sort());
 const evaluation=await loadDailyLoss(request([overridden,profitable,funded],'evaluation'),asOf);assert.deepEqual(evaluation.rows.map(row=>row.account),[overridden,profitable].sort());assert.equal(evaluation.rows.find(row=>row.account===profitable)!.markedUpgraded,false);assert.equal(changes(),before);
});
test('oversized histories are refused from metadata before payload reads, and four-account work is explicitly bounded',async()=>{
 const tooMany='BOUND-FILLS',tooBig='BOUND-BYTES';
 history(tooMany,Array(DAILY_LOSS_MAX_FILLS+1).fill({}));history(tooBig,[],'x'.repeat(DAILY_LOSS_MAX_BYTES));
 queries.length=0;const before=changes(),limits=await loadDailyLoss(request([tooMany,tooBig]),asOf);
 assert.equal(queries.length,1);assert.deepEqual(limits.unavailable.map(row=>row.reason),['history-limit','history-limit']);assert.equal(limits.rows.length,0);assert.equal(changes(),before);
 const accounts=['BATCH-A','BATCH-B','BATCH-C','BATCH-D'];for(const account of accounts)history(account,Array(33334).fill({}));
 queries.length=0;const batch=await loadDailyLoss(request(accounts),asOf);
 assert.equal(queries.length,2);assert.equal(queries[1].parameters.length,4);assert.deepEqual(batch.unavailable.filter(row=>row.reason==='history-limit').map(row=>row.account),['BATCH-C','BATCH-D']);
 for(const account of [...accounts,tooMany,tooBig])sqlite.prepare('DELETE FROM account_history WHERE account=?').run(account);
});
test('invalid history and SQL-bound account strings remain explicit, with no query for invalid requests',async()=>{
 const account='LFF05000000000105',injection="x'); DROP TABLE account_history;--";
 history(account,[{...fill('1','Buy',1000,1),time:'unknown'}]);
 const result=await loadDailyLoss(request([account,injection]),asOf);
 assert.ok(result.unavailable.some(row=>row.account===account&&row.reason==='invalid-history'));assert.ok(result.unavailable.some(row=>row.account===injection&&row.reason==='missing'));assert.equal(result.rows.length,0);
 queries.length=0;await assert.rejects(()=>loadDailyLoss({...request([account]),accounts:Array(5).fill(account)},asOf));assert.equal(queries.length,0);
});
test('a maximal date/account scope returns at most 1,464 compact session rows',async()=>{
 const accounts=Array.from({length:4},(_,i)=>'LFF0500000000020'+i),yearStart=Date.parse('2028-01-01T14:00:00Z');
 for(const account of accounts)history(account,Array.from({length:366},(_,i)=>fill(String(i+1),'Buy',1000,i+1,new Date(yearStart+i*86400000).toISOString())));
 const before=changes(),result=await loadDailyLoss({accounts,start:'2028-01-01',end:'2028-12-31',stage:'all'},Date.parse('2029-01-01T00:00:00Z'));
 assert.equal(result.rows.length,DAILY_LOSS_MAX_ROWS);assert.ok(result.rows.every(row=>row.complete));assert.equal(changes(),before);
 for(const account of accounts)sqlite.prepare('DELETE FROM account_history WHERE account=?').run(account);
});
test('cached events are read only, revision checked and invalidated when a future execution becomes due',async()=>{
 const account='LFF05000000000106',now=Date.now(),past=new Date(now-120000).toISOString(),future=new Date(now+60000).toISOString();
 // Remove the intentionally invalid fixture before warming the ordinary
 // journal cache. Only the diagnostic itself is under the read-only assertion.
 sqlite.prepare('DELETE FROM account_history WHERE account=?').run('LFF05000000000105');
 history(account,[fill('1','Buy',1000,1,past),fill('2','Sell',1100,0,future)]);
 sqlite.prepare("INSERT INTO journal_meta(key,value) VALUES ('seed_version','synthetic')").run();
 readonly=false;try{await journal.loadJournal();}finally{readonly=true;}
 const before=changes(),cached=journal.cachedRealizedEvents(account,1,now);
 assert.ok(cached);assert.equal(cached.length,1);assert.equal(journal.cachedRealizedEvents(account,2,now),null);assert.equal(journal.cachedRealizedEvents(account,1,now+60001),null);
 queries.length=0;const currentDay=String(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now))),result=await loadDailyLoss({...request([account]),start:currentDay,end:currentDay},now);
 assert.equal(queries.length,1);assert.equal(changes(),before);assert.equal(result.unavailable.length,0);
});
