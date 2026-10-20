import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

let requestHeaders = new Headers();
let journalReads = 0;
let accountReads=0,accountWrites=0,firmWrites=0,firmPayoutWrites=0;
const importedPayloads:Record<string,unknown>[]=[];
const originalLoad = (Module as any)._load;
(Module as any)._load = function(name: string, ...rest: any[]) {
  if(name==='../../../lib/server-prices')return {loadPriceBars:async()=>[],loadWeeklyGapBars:async()=>[],savePriceBars:async()=>({confirmed:1})};
  if (name === 'next/headers') return { headers: async () => requestHeaders };
  if (name === 'next/navigation') return { redirect: (location: string) => { throw new Error('REDIRECT ' + location); } };
  if (name === '../../../lib/server-journal') return {
    backupResponse:async()=>Response.json({format:'tradebook-backup-v1'}),
    importFirmPayouts: async()=>{firmPayoutWrites++;return {added:1,duplicates:0};},
    saveFirmReference: async()=>{firmWrites++;return {account:'LFE-TEST'};},
    loadAccountState: async()=>{accountReads++;return {monitor:null,accounts:[]};},
    saveAccountState: async()=>{accountWrites++;return {accepted:true,capturedAt:'2026-10-16T21:00:00.000Z'};},
    loadJournalVersion: async()=>({revision:'verified-revision'}),
    loadJournal: async () => { journalReads++; return { ready: true, accounts: [] }; },
    importExecutions: async (payload:Record<string,unknown>) => { importedPayloads.push(payload); return { added: 2, duplicates: 0 }; },
  };
  return originalLoad.call(this, name, ...rest);
};
const auth = require('../app/chatgpt-auth') as typeof import('../app/chatgpt-auth');
const route = require('../app/api/[...path]/route') as typeof import('../app/api/[...path]/route');
(Module as any)._load = originalLoad;

test('price history requires native sign-in for reads and same-origin authenticated uploads',async()=>{
  const get=()=>new Request('https://journal.example/api/prices?contract=MES%202026-12&start=1&end=2');
  const post=(origin='https://journal.example')=>new Request('https://journal.example/api/prices',{method:'POST',headers:{Origin:origin},body:JSON.stringify({bars:[]})});
  requestHeaders=new Headers();assert.equal((await route.GET(get())).status,401);assert.equal((await route.POST(post())).status,401);
  requestHeaders=new Headers({'oai-authenticated-user-email':'owner@example.test'});
  assert.equal((await route.POST(post('https://other.example'))).status,403);assert.equal((await route.POST(post())).status,200);assert.equal((await route.GET(get())).status,200);
});

test('authenticated email-only Sites requests open the private journal without a sign-in redirect', async () => {
  // Match the identity header shape in the failing hosted browser requests.
  requestHeaders = new Headers({
    'oai-authenticated-user-email': 'owner@example.test',
    'oai-authenticated-user-full-name': 'Test%20Owner',
    'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8',
  });
  const user = await auth.requireChatGPTUser('/');
  assert.equal(user.email, 'owner@example.test');
  assert.equal(user.userId, null);
  assert.equal(user.displayName, 'Test Owner');
  const response = await route.GET(new Request('https://journal.example/api/journal'));
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { ready: boolean }).ready, true);
  assert.equal(journalReads, 1);
  const version=await route.GET(new Request('https://journal.example/api/journal-version'));assert.equal(version.status,200);assert.equal(((await version.json())as {revision:string}).revision,'verified-revision');
});

test('missing authenticated email still blocks page and journal API access', async () => {
  for (const values of [new Headers(), new Headers({ 'oai-authenticated-user-id': 'site-user' })]) {
    requestHeaders = values;
    assert.equal(await auth.getChatGPTUser(), null);
    await assert.rejects(() => auth.requireChatGPTUser('/'), /REDIRECT \/signin-with-chatgpt\?return_to=%2F/);
    const response = await route.GET(new Request('https://journal.example/api/journal'));
    assert.equal(response.status, 401);
    assert.equal((await route.GET(new Request('https://journal.example/api/journal-version'))).status,401);
  }
  assert.equal(journalReads, 1);
});

test('complete Sites identity keeps the real user ID and rejects cross-origin mutations', async () => {
  requestHeaders = new Headers({
    'oai-authenticated-user-email': 'owner@example.test',
    'oai-authenticated-user-id': 'real-site-user-id',
    'oai-authenticated-user-full-name': '%invalid',
    'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8',
  });
  const user = await auth.getChatGPTUser();
  assert.equal(user?.userId, 'real-site-user-id');
  assert.equal(user?.displayName, 'owner@example.test');
  const response = await route.POST(new Request('https://journal.example/api/profile', {
    method: 'POST', headers: { Origin: 'https://other.example' }, body: '{}',
  }));
  assert.equal(response.status, 403);
});

test('owner-private service imports share the import handler and reject cross-origin requests',async()=>{
  requestHeaders=new Headers();
  const payload={source:'owner-upload.csv',checksum:'a'.repeat(64),chunk:0,fills:[]};
  const request=(path:string,origin?:string)=>new Request('https://journal.example/api/'+path,{method:'POST',headers:origin?{Origin:origin}:{},body:JSON.stringify({action:'import',payload})});
  assert.equal((await route.POST(request('import'))).status,401);
  assert.equal((await route.POST(request('maintenance','https://other.example'))).status,403);
  // The hosted Sites boundary supplies service authorization before dispatch.
  // This unit test covers the application handler after that boundary.
  const response=await route.POST(request('maintenance'));
  assert.equal(response.status,200);assert.deepEqual(importedPayloads,[payload]);
});

test('automatic recorder imports require sign-in, same-origin requests and non-simulator capture mode',async(t)=>{
  t.mock.method(console,'error',()=>{});
  const request=(body:unknown,origin='https://journal.example')=>new Request('https://journal.example/api/recorder-import',{method:'POST',headers:{Origin:origin},body:JSON.stringify(body)});
  requestHeaders=new Headers();assert.equal((await route.POST(request({mode:'AccountsReadOnly',fills:[{account:'LFE-TEST'}]}))).status,401);
  requestHeaders=new Headers({'oai-authenticated-user-email':'owner@example.test'});
  assert.equal((await route.POST(request({mode:'AccountsReadOnly',fills:[{account:'LFE-TEST'}]},'https://other.example'))).status,403);
  const before=importedPayloads.length;
  for(const body of [{mode:'Sim101Only',fills:[{account:'Sim101'}]},{mode:'AccountsReadOnly',fills:[{account:'Sim101'}]},{mode:'AccountsReadOnly',fills:[{account:'Playback101'}]}])assert.equal((await route.POST(request(body))).status,400);
  assert.equal(importedPayloads.length,before);
  const body={mode:'AccountsReadOnly',source:'recorder',checksum:'e'.repeat(64),chunk:0,fills:[{account:'LFE-TEST'}]};
  assert.equal((await route.POST(request(body))).status,200);assert.deepEqual(importedPayloads.at(-1),body);
});


test('balance and position snapshots use native sign-in and same-origin protection on both reads and writes',async()=>{
 const request=(origin?:string)=>new Request('https://journal.example/api/account-state',{method:'POST',headers:origin?{Origin:origin}:{},body:'{}'});
 requestHeaders=new Headers();assert.equal((await route.GET(new Request('https://journal.example/api/account-state'))).status,401);assert.equal((await route.POST(request())).status,401);assert.equal(accountReads,0);assert.equal(accountWrites,0);
 requestHeaders=new Headers({'oai-authenticated-user-email':'owner@example.test'});
 assert.equal((await route.POST(request('https://other.example'))).status,403);assert.equal(accountWrites,0);
 assert.equal((await route.POST(request('https://journal.example'))).status,200);assert.equal((await route.GET(new Request('https://journal.example/api/account-state'))).status,200);assert.equal(accountWrites,1);assert.equal(accountReads,1);
 assert.equal((await route.POST(new Request('https://journal.example/api/account-state',{method:'POST',body:' '.repeat(1024*1024+1)}))).status,413);assert.equal(accountWrites,1);
});


test('firm records require native sign-in and same-origin requests, including the owner-private service route',async()=>{
 const request=(path='firm-reference',origin?:string)=>new Request('https://journal.example/api/'+path,{method:'POST',headers:origin?{Origin:origin}:{},body:JSON.stringify({action:'firm-reference',payload:{account:'LFE-TEST'}})});
 requestHeaders=new Headers();assert.equal((await route.POST(request())).status,401);assert.equal(firmWrites,0);
 requestHeaders=new Headers({'oai-authenticated-user-email':'owner@example.test'});assert.equal((await route.POST(request('firm-reference','https://other.example'))).status,403);assert.equal(firmWrites,0);
 assert.equal((await route.POST(request('firm-reference','https://journal.example'))).status,200);assert.equal(firmWrites,1);
 requestHeaders=new Headers();assert.equal((await route.POST(request('maintenance','https://other.example'))).status,403);assert.equal(firmWrites,1);
 assert.equal((await route.POST(request('maintenance'))).status,200);assert.equal(firmWrites,2);
});


test('firm payout imports require native sign-in or owner-private service access and reject cross-origin requests',async()=>{
 const request=(path='firm-payout-import',origin='https://journal.example')=>new Request('https://journal.example/api/'+path,{method:'POST',headers:{Origin:origin},body:JSON.stringify(path==='maintenance'?{action:'firm-payout-import',payload:{records:[]}}:{records:[]})});
 requestHeaders=new Headers();assert.equal((await route.POST(request())).status,401);assert.equal(firmPayoutWrites,0);
 requestHeaders=new Headers({'oai-authenticated-user-email':'owner@example.test'});assert.equal((await route.POST(request('firm-payout-import','https://other.example'))).status,403);assert.equal(firmPayoutWrites,0);
 assert.equal((await route.POST(request())).status,200);assert.equal(firmPayoutWrites,1);
 requestHeaders=new Headers();assert.equal((await route.POST(request('maintenance','https://other.example'))).status,403);assert.equal(firmPayoutWrites,1);assert.equal((await route.POST(request('maintenance'))).status,200);assert.equal(firmPayoutWrites,2);
});


test('owner-private service backup is read-only and rejects cross-origin requests',async()=>{
 requestHeaders=new Headers();
 const request=(origin='https://journal.example')=>new Request('https://journal.example/api/maintenance',{method:'POST',headers:{Origin:origin},body:JSON.stringify({action:'backup'})});
 assert.equal((await route.POST(request('https://other.example'))).status,403);
 assert.equal((await route.POST(request())).status,200);
 assert.equal((await route.GET(new Request('https://journal.example/api/backup'))).status,401);
});


test('weekly-gap boundary reads require native journal sign-in',async()=>{
 const request=new Request('https://journal.example/api/weekly-gap-bars?contract=NQ%202026-12&asOf=1792500000000');
 requestHeaders=new Headers();assert.equal((await route.GET(request)).status,401);
 requestHeaders=new Headers({'oai-authenticated-user-email':'owner@example.test'});assert.equal((await route.GET(request)).status,200);
});
