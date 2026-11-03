import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {journalBackupResponse} from '../lib/server-backup';

const metadata={format:'tradebook-backup-v1',exportedAt:'2026-10-01T12:00:00.000Z',timezone:'America/Chicago',seedVersion:'synthetic',accountState:{monitor:null,accounts:[]},firmReferences:[],firmAdjustments:[]};
function fixture(count:number){
 const sql=new DatabaseSync(':memory:');
 for(const file of fs.readdirSync('drizzle').filter(file=>file.endsWith('.sql')).sort())sql.exec(fs.readFileSync('drizzle/'+file,'utf8'));
 const queries:{text:string;values:(string|number)[];plan:string[]}[]=[],expected:Record<string,unknown[]>={profiles:[],notes:[],cash:[],imports:[],history:[],balanceObservations:[],recorderCaptures:[],adjustmentLabels:[],executionTimes:[],priceBars:[]};
 let beforeQuery:((text:string,values:(string|number)[])=>void)|undefined;
 class Statement{
  constructor(private text:string,private values:(string|number)[]=[]){ }
  bind(...values:(string|number)[]){return new Statement(this.text,values);}
  async all(){
   assert.match(this.text,/^SELECT /);assert.doesNotMatch(this.text,/\bOFFSET\b/);
   beforeQuery?.(this.text,this.values);
   const plan=sql.prepare('EXPLAIN QUERY PLAN '+this.text).all(...this.values).map(row=>String(row.detail));
   queries.push({text:this.text,values:this.values,plan});
   return {results:sql.prepare(this.text).all(...this.values)};
  }
 }
 const database={prepare:(text:string)=>new Statement(text)} as unknown as Pick<D1Database,'prepare'>;
 // Deliberately reverse physical insertion order and disagree with time order.
 for(let i=count-1;i>=0;i--){
  const id=String(i).padStart(5,'0'),account='ACCOUNT-'+id,time='2026-10-01T'+id,receivedAt='2026-10-02T00:00:00Z';
  for(const [name,table,key] of [['profiles','account_profiles','account'],['notes','trade_notes','id'],['cash','cash_records','id'],['adjustmentLabels','balance_adjustment_labels','id']] as const){
   const value={id,account,source:'synthetic '+name};expected[name].push(value);
   const columns=table==='trade_notes'?'id,account,data':key+',data',values=table==='trade_notes'?[id,account,JSON.stringify(value)]:[key==='account'?account:id,JSON.stringify(value)];
   sql.prepare(`INSERT INTO ${table}(${columns}) VALUES (${values.map(()=>'?').join(',')})`).run(...values);
  }
  if(i<9){const value={account,fills:[{id,price:100}],trades:[],issues:[],retained:'unchanged'};expected.history.push(value);sql.prepare("INSERT INTO account_history(account,data,updated) VALUES (?,?,'synthetic')").run(account,JSON.stringify(value));}
  const importedAt='2026-09-'+String(30-i%30).padStart(2,'0'),entry={id,source:'synthetic',added:i,duplicates:0,importedAt};expected.imports.push(entry);
  sql.prepare('INSERT INTO journal_imports VALUES (?,?,?,?,?)').run(id,entry.source,i,0,importedAt);
  const observation={id,account:'SHARED',capturedAt:'2026-10-01T00:00:00Z',receivedAt:'stale',extra:{preserved:true}};
  expected.balanceObservations.push({...observation,receivedAt});
  sql.prepare('INSERT INTO account_observations(id,account,captured_at,origin,data,received_at) VALUES (?,?,?,?,?,?)').run(id,observation.account,observation.capturedAt,'synthetic',JSON.stringify(observation),receivedAt);
  const capture={capturedAt:time,accounts:[],receivedAt:'stale'};expected.recorderCaptures.push({...capture,receivedAt});
  sql.prepare('INSERT INTO recorder_captures VALUES (?,?,?)').run(time,JSON.stringify(capture),receivedAt);
  const executionAccount=i<501?'ACCOUNT-A':'ACCOUNT-B',execution={account:executionAccount,time};expected.executionTimes.push(execution);
  sql.prepare('INSERT INTO execution_times VALUES (?,?)').run(executionAccount,time);
  const contract=i<501?'MNQ 2026-12':'NQ 2026-12',start=i*60000,bar={id:contract+'|'+start,contract,start,end:start+60000,open:1,high:3,low:0,close:2,volume:i,capturedAt:start+60000,receivedAt:start+61000};expected.priceBars.push(bar);
  sql.prepare('INSERT INTO price_bars VALUES (?,?,?,?,?,?,?,?,?)').run(contract,start,bar.open,bar.high,bar.low,bar.close,bar.volume,bar.capturedAt,bar.receivedAt);
 }
 const sorted=(rows:unknown[])=>rows.map(row=>JSON.stringify(row)).sort();
 return {sql,database,queries,expected,sorted,onQuery:(callback:typeof beforeQuery)=>{beforeQuery=callback;}};
}

for(const count of [0,1,500,1001])test(`backup preserves every source field across ${count} evidence rows and bounded history pages`,async()=>{
 const f=fixture(count),before=f.sql.prepare('SELECT total_changes() AS n').get()!.n;
 const response=journalBackupResponse(f.database,metadata),actual=await response.json() as Record<string,unknown>;
 for(const [key,value] of Object.entries(metadata))assert.deepEqual(actual[key],value);
 for(const [key,rows] of Object.entries(f.expected))assert.deepEqual(f.sorted(actual[key] as unknown[]),f.sorted(rows),key);
 assert.equal(f.sql.prepare('SELECT total_changes() AS n').get()!.n,before);
 assert.match(response.headers.get('Content-Disposition')!,/2026-10-01\.json/);
 for(const query of f.queries){
  assert.match(query.text,/LIMIT (?:4|500)$/);
  if(query.values.length){assert.ok(query.plan.some(line=>line.includes('SEARCH')),query.plan.join(';'));assert.ok(query.plan.every(line=>!line.includes('TEMP B-TREE')&&!line.includes('SCAN ')),query.plan.join(';'));}
 }
 if(count>500){assert.equal(f.queries.filter(q=>/FROM account_history/.test(q.text)).length,3);assert.equal(f.queries.filter(q=>/FROM account_observations/.test(q.text)).length,3);}
 f.sql.close();
});

test('concurrent appends ahead of the cursor are included once without shifting saved rows',async()=>{
 const f=fixture(1001);let appended=false;
 f.onQuery((text,values)=>{if(appended||!text.includes('FROM account_observations')||!values.length)return;appended=true;
  for(const id of ['-behind-cursor','zz-after-cursor'])f.sql.prepare("INSERT INTO account_observations(id,account,captured_at,origin,data,received_at) VALUES (?,'SHARED','same','synthetic',?,'received')").run(id,JSON.stringify({id}));
 });
 const actual=await journalBackupResponse(f.database,metadata).json() as {balanceObservations:{id:string}[]};
 const ids=actual.balanceObservations.map(row=>row.id);
 assert.equal(ids.length,1002);assert.equal(new Set(ids).size,1002);assert.ok(ids.includes('zz-after-cursor'));assert.ok(!ids.includes('-behind-cursor'));
 for(const row of f.expected.balanceObservations)assert.ok(ids.includes((row as {id:string}).id));
 f.sql.close();
});

test('cancelling export stops later database reads and database failure rejects the download',async()=>{
 const f=fixture(1001),reader=journalBackupResponse(f.database,metadata).body!.getReader();
 while(!f.queries.length)await reader.read();
 await reader.cancel();const count=f.queries.length;await Promise.resolve();assert.equal(f.queries.length,count);assert.ok(count<10);
 f.onQuery((text,values)=>{if(text.includes('FROM account_observations')&&values.length)throw new Error('synthetic database unavailable');});
 await assert.rejects(()=>journalBackupResponse(f.database,metadata).text(),/synthetic database unavailable/);
 f.sql.close();
});
