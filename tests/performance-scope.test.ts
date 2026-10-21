import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Journal,Trade,AccountProfile} from '../lib/types';
import type {RealizedDay} from '../lib/realized';
import {summarize} from '../lib/analytics';
import {journalForYear} from '../lib/reporting-year';
import {validateFirmReference} from '../lib/firm-reference';
import {matchesPerformanceStage,performanceAccountStages,scopePerformance} from '../lib/performance-scope';

const funded='LFF05000000000010',evaluation='LFE05000000000020',unknown='SYNTHETIC-OTHER',partial='LFF05000000000030';
function trade(id:string,account:string,pnl:number,symbol='NQ',day='20'):Trade{return {id,account,contract:symbol+' 2026-12',symbol,dir:'Long',entry:'2026-10-'+day+'T14:00:00Z',exit:'2026-10-'+day+'T15:00:00Z',qty:1,maxQty:1,avgEntry:100,avgExit:101,pnl,exitOrder:0};}
function realized(account:string,symbol='NQ',net:number|null=100):RealizedDay{return {account,contract:symbol+' 2026-12',symbol,day:'2026-10-20',gross:101,commissions:net===null?null:1,net,exits:1,quantity:1,unmatched:0};}
function profile(account:string,stage:string,status='Active'):AccountProfile{return {account,stage,status,label:'',notes:''};}
function reference(account:string,stage:'Funded'|'Evaluation'){return validateFirmReference({account,firm:'Synthetic',date:'2026-10-19',currency:'USD',balance:50000,source:'Synthetic test checkpoint',flex:{stage,consistencyPercent:null,qualifyingDays:stage==='Funded'?1:null,capturedAt:'2026-10-19T14:00:00Z'}},'2026-10-21T14:00:00Z');}
function journal():Journal{
 const trades=[trade('f-win',funded,200),trade('e-win',evaluation,500),trade('u-win',unknown,100),trade('f-loss',funded,-50,'MNQ','21'),trade('e-loss',evaluation,-800,'MNQ','21')];
 const rows=[realized(funded),realized(evaluation),realized(unknown),realized(partial,'MES',null)];
 return {ready:true,trades,accounts:[funded,evaluation,unknown,partial].map(account=>({account,fills:2,issues:[],first:'2026-10-20T14:00:00Z',last:'2026-10-21T15:00:00Z'})),profiles:[],notes:[],cash:[{id:'payout',kind:'payout',account:funded,date:'2026-10-20',deduction:1000,received:900,expense:null,note:''}],imports:[],lastSaved:'',seedVersion:'synthetic',realized:rows,realizedSessions:rows.map(row=>({...row,day:'2026-10-21'}))};
}

test('Both preserves the existing combined analysis, unknown stages and source identities',()=>{
 const data=journal(),original=JSON.stringify(data),scoped=scopePerformance(data,'all');
 assert.deepEqual(scoped.trades,data.trades);assert.deepEqual(scoped.realized,data.realized);assert.deepEqual(scoped.sessions,data.realizedSessions);assert.deepEqual(scoped.accounts,data.accounts);
 assert.equal(summarize(scoped.trades).gross,-50);assert.equal(scoped.trades[0],data.trades[0]);assert.equal(scoped.account,'all');assert.equal(JSON.stringify(data),original);
});
test('funded and evaluation statistics use their own complete trade populations including old failed or upgraded accounts',()=>{
 const data=journal();data.profiles=[profile(funded,'Unclassified','Failed'),profile(evaluation,'Unclassified','Upgraded')];
 const f=scopePerformance(data,'funded'),e=scopePerformance(data,'evaluation'),fs=summarize(f.trades),es=summarize(e.trades);
 assert.deepEqual(f.trades.map(t=>t.id),['f-win','f-loss']);assert.deepEqual(e.trades.map(t=>t.id),['e-win','e-loss']);
 assert.equal(fs.gross,150);assert.equal(fs.count,2);assert.equal(fs.winRate,.5);assert.equal(fs.drawdown,50);
 assert.equal(es.gross,-300);assert.equal(es.count,2);assert.equal(es.winRate,.5);assert.equal(es.drawdown,800);
 assert.deepEqual(f.accounts.map(a=>a.account),[funded,partial]);assert.deepEqual(e.accounts.map(a=>a.account),[evaluation]);
});
test('explicit profiles and firm stage references override prefixes without reclassifying based on status or profit',()=>{
 const data=journal();data.firmReferences=[reference(funded,'Evaluation'),reference(evaluation,'Funded')];data.profiles=[profile(evaluation,'Evaluation')];
 const stages=performanceAccountStages(data);assert.equal(stages.get(funded),'Evaluation');assert.equal(stages.get(evaluation),'Evaluation');assert.equal(stages.get(unknown),'Unclassified');
 assert.equal(scopePerformance(data,'funded').trades.length,0);assert.equal(scopePerformance(data,'evaluation').trades.length,4);
 data.profiles=[profile(funded,'Funded')];assert.equal(scopePerformance(data,'funded').trades.length,4);
});
test('an incompatible individual account resets to the selected group while compatible selections and instruments intersect',()=>{
 const data=journal(),fundedScope=scopePerformance(data,'funded',evaluation,'MNQ');
 assert.equal(fundedScope.account,'all');assert.deepEqual(fundedScope.trades.map(t=>t.id),['f-loss']);
 const compatible=scopePerformance(data,'evaluation',evaluation,'MNQ');assert.equal(compatible.account,evaluation);assert.deepEqual(compatible.trades.map(t=>t.id),['e-loss']);
 const combined=scopePerformance(data,'all',unknown,'NQ');assert.equal(combined.account,unknown);assert.deepEqual(combined.trades.map(t=>t.id),['u-win']);
});
test('realized daily and session scopes retain partial exits, fees and unknown coverage independently of completed trades',()=>{
 const data=journal();data.realized!.push({...realized(funded,'NQ',-1),gross:0,exits:0,quantity:0});
 const f=scopePerformance(data,'funded'),e=scopePerformance(data,'evaluation');
 assert.equal(f.realized.length,3);assert.equal(e.realized.length,1);assert.equal(f.sessions.length,2);assert.equal(e.sessions.length,1);
 assert.ok(f.realized.some(row=>row.account===partial&&row.net===null));assert.ok(!f.trades.some(row=>row.account===partial));assert.ok(f.realized.some(row=>row.exits===0&&row.net===-1));
 assert.equal(scopePerformance(data,'funded','all','MES').realized[0].account,partial);
});
test('native comparisons classify newly connected accounts directly and preserve full-source profile overrides',()=>{
 const data=journal(),native='LFF05000000000040';data.profiles=[profile(native,'Evaluation')];
 const report=journalForYear(data);assert.ok(!report.profiles.some(p=>p.account===native));
 const f=scopePerformance(report,'funded','all','all',data);assert.equal(matchesPerformanceStage(native,'funded',f.stages),false);assert.equal(matchesPerformanceStage(native,'evaluation',f.stages),true);
 const newFunded='LFF05000000000050';assert.equal(matchesPerformanceStage(newFunded,'funded',f.stages),true);assert.equal(matchesPerformanceStage(newFunded,'evaluation',f.stages),false);
});
test('unknown products remain only in Both and switching back restores them without changing cash or raw data',()=>{
 const data=journal(),before=JSON.stringify(data),stages=performanceAccountStages(data);
 for(const name of [unknown,'LFF10000000000010','LFE050bad','CUSTOM-FUNDED-NAME']){assert.equal(matchesPerformanceStage(name,'all',stages),true);assert.equal(matchesPerformanceStage(name,'funded',stages),false);assert.equal(matchesPerformanceStage(name,'evaluation',stages),false);}
 scopePerformance(data,'funded');scopePerformance(data,'evaluation');assert.equal(JSON.stringify(data),before);assert.equal(scopePerformance(data,'all').trades.length,5);assert.equal(data.cash[0].received,900);
});
