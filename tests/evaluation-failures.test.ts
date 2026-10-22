import {test} from 'node:test';
import assert from 'node:assert/strict';
import {effectiveAccountStatus,evaluationFailures,observedEvaluationEquity} from '../lib/evaluation-failures';
import type {EvaluationObservation} from '../lib/evaluation-failures';
import type {RealizedEvent} from '../lib/realized';
import type {AccountProfile} from '../lib/types';
import {validateFirmReference} from '../lib/firm-reference';

const account='LFE05000000000101',asOf=Date.parse('2026-10-22T21:00:00Z');
function point(cash:number,capturedAt='2026-10-21T20:00:00Z',patch:Partial<EvaluationObservation>={}):EvaluationObservation{return {account,capturedAt,cash,cashAt:capturedAt,net:null,netAt:null,connected:1,currency:'USD',connection:'Synthetic',provider:'Synthetic',positionsAvailable:1,positionsAt:capturedAt,positionData:'[]',...patch};}
function event(net:number|null,time:string,patch:Partial<RealizedEvent>={}):RealizedEvent{return {account,contract:'MNQ 2026-12',symbol:'MNQ',time,fillId:time,ordinal:0,gross:net??0,commissions:0,net,exits:1,quantity:1,unmatched:0,coverageIssues:0,...patch};}
function run(rows:EvaluationObservation[],ledger:RealizedEvent[]=[],extra:Partial<Parameters<typeof evaluationFailures>[0]>={}){return evaluationFailures({rows,events:new Map([[account,ledger]]),asOf,...extra});}
const profile=(stage='Evaluation',status='Active'):AccountProfile=>({account,label:'Synthetic',stage,status,notes:''});

test('initial loss floor is inclusive, rounded to cents, and needs no trade history',()=>{
 assert.equal(run([point(48000.01)]).length,0);
 assert.deepEqual(run([point(48000)]),[{account,at:'2026-10-21T20:00:00Z',balance:48000,floor:48000,source:'cash'}]);
 assert.equal(run([point(47999.99)])[0].floor,48000);
});
test('only confirmed 50K evaluation family and effective evaluation stage qualify',()=>{
 assert.equal(run([point(47000)],[],{profiles:[profile('Funded')]}).length,0);
 for(const other of ['LFF05000000000101','LFE02500000000101','TD-SYNTHETIC','Sim101'])assert.equal(run([point(47000,undefined,{account:other})]).length,0);
 assert.equal(run([point(47000)],[],{profiles:[profile('Evaluation')]}).length,1);
});
test('flat cash ignores unsupported zero equity and open positions use floating equity',()=>{
 assert.equal(run([point(50000,undefined,{equity:0,equityAt:'2026-10-21T20:00:00Z'})]).length,0);
 const open={positionsAvailable:1,positionsAt:'2026-10-21T20:00:00Z',positionData:'[{"quantity":1}]'};
 assert.equal(run([point(47500,undefined,{...open,floating:1000,floatingAt:'2026-10-21T20:00:00Z'})]).length,0);
 assert.equal(run([point(50000,undefined,{...open,floating:-2100,floatingAt:'2026-10-21T20:00:00Z'})])[0].balance,47900);
 assert.equal(run([point(47500,undefined,open)]).length,0);
});
test('stale, disconnected, unsupported zero, foreign currency and future readings cannot create breaches',()=>{
 for(const patch of [{cashAt:'2026-10-20T20:00:00Z'},{connected:0},{currency:'CAD'},{positionsAvailable:0,positionsAt:null,positionData:null},{cash:0,equity:0,equityAt:'2026-10-21T20:00:00Z'}])assert.equal(run([point(47000,undefined,patch)]).length,0);
 assert.equal(run([point(47000,'2026-10-23T20:00:00Z')]).length,0);
 const p=point(50000,undefined,{positionsAvailable:0,equity:47900,equityAt:'2026-10-21T20:00:00Z'});assert.equal(observedEvaluationEquity(p)?.source,'equity');assert.equal(run([p]).length,1);
});
test('completed session net advances the trail and current session profits do not',()=>{
 const ledger=[event(1000,'2026-10-20T15:00:00Z')],anchor=point(51000,'2026-10-20T20:00:00Z');
 assert.equal(run([anchor,point(49000.01)],[...ledger,event(-1999.99,'2026-10-21T19:00:00Z')]).length,0);
 assert.equal(run([anchor,point(49000)],[...ledger,event(-2000,'2026-10-21T19:00:00Z')])[0].floor,49000);
 const sameDay=run([anchor,point(48500,'2026-10-20T21:00:00Z')],[...ledger,event(-2500,'2026-10-20T20:59:00Z')]);assert.equal(sameDay.length,0);
});
test('an early snapshot high is not a closing balance when later fills give profit back',()=>{
 const ledger=[event(2000,'2026-10-20T15:00:00Z'),event(-1500,'2026-10-20T20:30:00Z'),event(-1500,'2026-10-21T19:00:00Z')];
 const rows=[point(52000,'2026-10-20T16:00:00Z'),point(49000)];
 assert.equal(run(rows,ledger).length,0);
 assert.equal(run([...rows,point(48500,'2026-10-21T20:10:00Z')],[...ledger,event(-500,'2026-10-21T20:05:00Z')])[0].floor,48500);
});
test('the trail never drops after a losing session and locks at 50100',()=>{
 const ledger=[event(3000,'2026-10-19T15:00:00Z'),event(-1000,'2026-10-20T15:00:00Z')];
 const rows=[point(53000,'2026-10-19T20:00:00Z'),point(52000,'2026-10-20T20:00:00Z'),point(50100)];
 assert.equal(run(rows,ledger)[0].floor,50100);
});
test('unknown costs and inventory never manufacture a higher floor',()=>{
 for(const unknown of [event(null,'2026-10-20T15:00:00Z'),event(2000,'2026-10-20T15:00:00Z',{unmatched:1}),event(2000,'2026-10-20T15:00:00Z',{coverageIssues:1})]){
  assert.equal(run([point(49000)],[unknown]).length,0);
  assert.equal(run([point(47900)],[unknown])[0].floor,48000);
 }
});
test('a clean imported suffix is anchored to actual cash instead of assumed opening history',()=>{
 const ledger=[event(2000,'2026-10-20T15:00:00Z'),event(-1500,'2026-10-21T15:00:00Z')];
 assert.equal(run([point(49500)],ledger).length,0);
 assert.equal(run([point(49000)],ledger).length,0); // actual earlier close 50500, floor48500
});
test('a settled flat reading restores a model after unknown earlier coverage',()=>{
 const ledger=[event(null,'2026-10-19T15:00:00Z'),event(500,'2026-10-20T15:00:00Z'),event(-2000,'2026-10-21T19:00:00Z')];
 const rows=[point(51000,'2026-10-19T20:00:00Z'),point(49500)];
 assert.equal(run(rows,ledger)[0].floor,49500);
});
test('dated firm floors apply from their own capture time and respect explicit stage overrides',()=>{
 const reference=validateFirmReference({account,firm:'Lucid',date:'2026-10-21',currency:'USD',minimumBalance:50000,source:'Synthetic',flex:{stage:'Evaluation',consistencyPercent:40,qualifyingDays:null,capturedAt:'2026-10-21T19:00:00Z'}},'2026-10-21T20:00:00Z');
 assert.equal(run([point(49000,'2026-10-20T20:00:00Z')],[],{references:[reference]}).length,0);
 assert.equal(run([point(49000)],[],{references:[reference]})[0].floor,50000);
 assert.equal(run([point(49000)],[],{references:[reference],profiles:[profile('Funded')]}).length,0);
});
test('a historical breach survives later recovery and absent/disconnected account snapshots',()=>{
 const rows=[point(47900),point(50000,'2026-10-21T20:10:00Z'),point(0,'2026-10-22T19:00:00Z',{connected:0})];
 assert.equal(run(rows)[0].at,'2026-10-21T20:00:00Z');assert.equal(run([...rows].reverse())[0].at,'2026-10-21T20:00:00Z');
});
test('unknown firm removals interrupt modeled balances without lowering a known floor or becoming trading losses',()=>{
 const ledger=[event(2000,'2026-10-19T15:00:00Z'),event(1000,'2026-10-20T15:00:00Z')];
 const rows=[point(52000,'2026-10-19T20:00:00Z'),point(50001)];
 const notices=[{id:'synthetic-removal',date:'2026-10-20',accounts:[account],kind:'hedging-profit-removal' as const,amount:null,source:'Synthetic'}];
 const reference=validateFirmReference({account,firm:'Lucid',date:'2026-10-19',currency:'USD',minimumBalance:50000,source:'Synthetic'},'2026-10-19T21:00:00Z');
 assert.equal(run(rows,ledger,{notices,references:[reference]}).length,0);
 assert.equal(run([...rows,point(50000,'2026-10-21T20:10:00Z')],ledger,{notices,references:[reference]})[0].floor,50000);
});
test('derived failure preserves manual terminal statuses and does not mutate the profile',()=>{
 const p=profile(),before=JSON.stringify(p),failures=run([point(47900)]);
 assert.equal(effectiveAccountStatus(account,p,failures),'Failed');assert.equal(JSON.stringify(p),before);
 for(const status of ['Failed','Upgraded','Retired'])assert.equal(effectiveAccountStatus(account,profile('Evaluation',status),failures),status);
 assert.equal(effectiveAccountStatus(account,p,[]),'Active');
});

test('a later contradictory cash endpoint cannot be failed using an uncorroborated modeled close',()=>{
 const ledger=[event(2000,'2026-10-20T15:00:00Z')];
 const rows=[point(50000,'2026-10-20T14:00:00Z'),point(49500)];
 assert.equal(run(rows,ledger).length,0);
 // A prior independently corroborated floor remains in force after that gap.
 const earlier=[event(1000,'2026-10-19T15:00:00Z'),...ledger];
 const known=[point(51000,'2026-10-19T20:00:00Z'),point(51000,'2026-10-20T14:00:00Z'),point(49000)];
 assert.equal(run(known,earlier)[0].floor,49000);
});

test('fresh cash while in a position prevents a later deposit from inventing earlier trailing floors',()=>{
 const rows=[point(50000,'2026-10-19T20:00:00Z',{positionData:'[{"quantity":1}]',floating:0,floatingAt:'2026-10-19T20:00:00Z'}),point(50000,'2026-10-20T20:00:00Z',{positionData:'[{"quantity":1}]',floating:-1000,floatingAt:'2026-10-20T20:00:00Z'}),point(53000)];
 assert.equal(run(rows).length,0);
});


test('a future first cash anchor cannot invent a higher floor for earlier equity-only observations',()=>{
 const rows=[point(50000,'2026-10-19T20:00:00Z',{cash:null,cashAt:null,positionsAvailable:0,equity:50000,equityAt:'2026-10-19T20:00:00Z'}),point(50000,'2026-10-20T20:00:00Z',{cash:null,cashAt:null,positionsAvailable:0,equity:49000,equityAt:'2026-10-20T20:00:00Z'}),point(53000)];
 assert.equal(run(rows).length,0);
});
