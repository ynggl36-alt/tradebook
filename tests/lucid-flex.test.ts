import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Trade,AccountProfile,CashRecord,Fill,Journal} from '../lib/types';
import {accountFlexProgress} from '../lib/account-display';
import {validateFirmReference} from '../lib/firm-reference';
import {accountStage,flexAccount,flexDaily,flexEvaluation,flexPayoutDays,flexSession,latestPayoutDeduction} from '../lib/lucid-flex';
import {aggregateRealized,realizedCheckpoint,realizedEvents} from '../lib/realized';
import type {RealizedCheckpoint,RealizedDay} from '../lib/realized';
import type {BalanceAdjustment} from '../lib/balance-adjustments';
const account='LFF05000000000010',stamp='2026-10-19T14:17:43.000Z';
function trade(net:number,exit='2026-10-19T15:00:00Z',id='t'):Trade{return {id,account,entry:exit,exit,qty:1,maxQty:1,symbol:'MNQ',contract:'MNQ 2026-12',dir:'Long',avgEntry:100,avgExit:110,pnl:net+1,exitOrder:1};}
const ref=(days=3,sessionPnl:number|null=null)=>validateFirmReference({account,firm:'Lucid Flex',date:'2026-10-19',currency:'USD',sessionPnl,source:'Owner screenshot',flex:{stage:'Funded',consistencyPercent:null,qualifyingDays:days,capturedAt:stamp}});
const session=(net:number|null,day='2026-10-19'):RealizedDay=>({account,contract:'MNQ 2026-12',symbol:'MNQ',day,gross:net===null?0:net+1,commissions:net===null?null:1,net,exits:1,quantity:1,unmatched:0});
const capture=(net:number|null,afterNet:number|null,extra:Partial<RealizedCheckpoint>={}):RealizedCheckpoint=>({account,capturedAt:stamp,session:'2026-10-19',net,afterNet,...extra});
const now=Date.parse('2026-10-19T16:00:00Z');
test('recognized 50K prefixes classify stages while explicit account labels override them',()=>{
 assert.equal(flexAccount(account)?.stage,'Funded');assert.equal(accountStage('LFE05000000000003'),'Evaluation');
 for(const a of ['OTHER0508026335','Sim101','LFF100123','LFE-TEST','LFF050foo'])assert.equal(flexAccount(a),null);
 const profile:AccountProfile={account,label:'',stage:'Evaluation',status:'Active',notes:''};assert.equal(accountStage(account,profile),'Evaluation');assert.equal(accountStage(account,{...profile,stage:'Unclassified'}),'Funded');
});
test('profit days group Sunday evening with Monday and follow Central daylight saving time',()=>{
 assert.equal(flexSession('2026-10-18T22:01:00Z'),'2026-10-19');assert.equal(flexSession('2026-10-19T01:00:00Z'),'2026-10-19');assert.equal(flexSession('2026-10-19T16:00:00Z'),'2026-10-19');
 assert.equal(flexSession('2026-12-13T23:01:00Z'),'2026-12-14');
 const rows=flexDaily([trade(75,'2026-10-18T22:01:00Z'),trade(75,'2026-10-19T14:00:00Z','b')]);assert.deepEqual(rows,[{day:'2026-10-19',net:150}]);
});
test('evaluation progress raises the target for the selected consistency option using net session profit',()=>{
 const trades=[trade(302,'2026-10-15T15:00:00Z'),trade(1537,'2026-10-16T15:00:00Z','b')];
 const result=flexEvaluation(trades,50);assert.equal(result.net,1839);assert.equal(result.target,3074);assert.equal(result.remaining,1235);assert.equal(result.consistency?.toFixed(2),'83.58');
 assert.equal(flexEvaluation(trades,40).target,3842.5);assert.equal(flexEvaluation(trades,null).consistencyPercent,null);
 assert.equal(flexEvaluation([{...trades[0],symbol:'GC'}],50).net,null);assert.equal(flexEvaluation([],50).net,null);
});
test('funded sessions count once and a current-session loss can undo its qualifying day',()=>{
 const first=trade(75),second=trade(75,'2026-10-19T15:01:00Z','b');
 assert.equal(flexPayoutDays(account,[],[],now).days,0);assert.equal(flexPayoutDays(account,[first],[],now).days,0);
 const result=flexPayoutDays(account,[first,second],[],now);assert.equal(result.days,1);assert.equal(result.remaining,4);assert.equal(result.today,150);
 assert.deepEqual(flexPayoutDays(account,[first,second],[],now),result);
 assert.equal(flexPayoutDays(account,[first,second,trade(-1,'2026-10-19T15:02:00Z','loss')],[],now).days,0);
 assert.equal(flexPayoutDays(account,[{...first,account:'LFF05000000000019'}],[],now).days,0);
});

test('saved payout dates without an observed deduction cannot invent a current cycle',()=>{
 const payout:CashRecord={id:'p',account,kind:'payout',date:'2026-10-19',deduction:1000,received:900,expense:null,note:''};
 for(const row of [payout,{...payout,payoutApprovalAt:'2026-10-19T15:00:00Z'}]){const result=flexPayoutDays(account,[trade(150,'2026-10-16T15:00:00Z'),trade(150)], [row],now);assert.equal(result.days,null);assert.equal(result.cycleProfit,null);assert.equal(result.reason,'payout');}
 const future={...payout,date:'2026-10-20'};assert.equal(flexPayoutDays(account,[trade(150)],[future],now).days,1);
});

test('unknown costs remain unknown while an empty new account starts at zero',()=>{
 const unknown=flexPayoutDays(account,[{...trade(150),symbol:'GC'}],[],now);assert.equal(unknown.days,null);assert.equal(unknown.reason,'costs');
 assert.equal(flexPayoutDays(account,[],[],now).days,0);assert.equal(flexPayoutDays(account,[trade(150)],[],now).days,1);
});

test('firm day checkpoints validate independently of money and reject inconsistent stages, counts and timestamps',()=>{
 const r=ref(0);assert.equal(r.flex?.qualifyingDays,0);assert.equal(r.balance,null);assert.equal(r.totalProfit,null);
 for(const bad of [{qualifyingDays:6},{qualifyingDays:-1},{qualifyingDays:1.5},{consistencyPercent:50},{stage:'Evaluation'},{capturedAt:'2026-02-30T14:17:43Z'},{capturedAt:'2099-10-19T14:17:43Z'}])assert.throws(()=>validateFirmReference({...r,flex:{...r.flex,...bad}}));
 assert.throws(()=>validateFirmReference({...r,account:'LFF-UNKNOWN'}));
});
test('session net determines qualifying days without adding fills and reported totals together',()=>{
 const options={sessions:[session(149)],reportedSessions:[{account,day:'2026-10-19',net:150,at:stamp}]};
 const result=flexPayoutDays(account,[trade(1000)],[],now,options);assert.equal(result.days,1);assert.equal(result.today,150);assert.equal(result.cycleProfit,150);
 assert.equal(flexPayoutDays(account,[],[],now,{sessions:[session(150),session(-1)]}).days,0);
});

test('saved firm day counts cannot seed or repair automatically calculated session counts',()=>{
 const base:Journal={ready:true,trades:[],accounts:[],profiles:[],notes:[],cash:[],imports:[],lastSaved:stamp,seedVersion:'synthetic',realizedSessions:[session(150)]};
 for(const days of [0,3,5]){const data={...base,firmReferences:[ref(days,10000)]};assert.equal(accountFlexProgress(account,data,now)?.payout.days,1);assert.equal(accountFlexProgress(account,data,now)?.payout.cycleProfit,150);}
 for(const days of [0,5])assert.equal(accountFlexProgress(account,{...base,firmReferences:[ref(days)],realizedSessions:[session(null)]},now)?.payout.days,null);
});

test('the compact ledger counts partial exits and entry commissions before a completed trade exists',()=>{
 const fill=(id:string,side:'Buy'|'Sell',qty:number,price:number,pos:number,time:string):Fill=>({id,side,qty,price,pos,time,contract:'MNQ 2026-12',symbol:'MNQ',pv:2,ordinal:Number(id)});
 const events=realizedEvents(account,[fill('1','Buy',2,100,2,'2026-10-19T14:00:00Z'),fill('2','Sell',1,200,1,'2026-10-19T15:00:00Z')]),options={sessions:aggregateRealized(events,'session'),checkpoints:[realizedCheckpoint(account,stamp,events)]};
 assert.deepEqual(flexDaily([],options),[{day:'2026-10-19',net:198.5}]);assert.equal(flexEvaluation([],50,options).net,198.5);
 assert.equal(flexPayoutDays(account,[],[],now,options).days,1);
 const entryOnly=realizedEvents(account,[fill('3','Buy',2,100,2,'2026-10-19T15:00:00Z')]),entryOptions={sessions:aggregateRealized(entryOnly,'session'),checkpoints:[realizedCheckpoint(account,stamp,entryOnly)]};
 const afterEntry=flexPayoutDays(account,[],[],now,entryOptions);assert.equal(afterEntry.days,0);assert.equal(afterEntry.today,-1);
 assert.equal(flexEvaluation([trade(500)],50,{sessions:[]}).net,null);
});
test('verified session observations replace unknown model results while unverified missing costs and inventory stay unknown',()=>{
 const result=flexPayoutDays(account,[],[],now,{sessions:[session(null)],reportedSessions:[{account,day:'2026-10-19',net:200,at:stamp}]});assert.equal(result.days,1);assert.equal(result.cycleProfit,200);
 assert.equal(flexPayoutDays(account,[],[],now,{sessions:[{...session(null),commissions:1,coverageIssues:1}]}).reason,'coverage');
 assert.equal(flexPayoutDays(account,[],[],now,{sessions:[session(null)]}).reason,'costs');
});

test('same-day unlinked payout timing stays ambiguous until actual deduction evidence links it',()=>{
 const payout:CashRecord={id:'approved-same-day',account,kind:'payout',date:'2026-10-19',deduction:2000,received:null,expense:null,note:''};
 assert.equal(flexPayoutDays(account,[],[payout],now,{adjustments:[deduction()]}).reason,'approval-time');
 assert.equal(flexPayoutDays(account,[],[payout],now,{adjustments:[deduction({payoutId:payout.id})]}).days,0);
});

test('future trades, sessions and exact approval timestamps do not advance or reset the current count',()=>{
 const tomorrow=trade(150,'2026-10-20T15:00:00Z'),futureApproval:CashRecord={id:'future',account,kind:'payout',date:'2026-10-19',deduction:null,received:null,expense:null,note:'',payoutApprovalAt:'2026-10-19T18:00:00Z'};
 assert.equal(flexPayoutDays(account,[tomorrow],[futureApproval],now).days,0);
 assert.equal(flexPayoutDays(account,[],[],now,{sessions:[session(150,'2026-10-20')],checkpoints:[capture(null,0)]}).days,0);
});
const deduction=(extra:Partial<BalanceAdjustment>={}):BalanceAdjustment=>({id:'new-deduction',account,date:'2026-10-19',from:'2026-10-19T14:59:00Z',to:'2026-10-19T15:00:00Z',before:54000,after:52000,tradingNet:0,amount:-2000,kind:'likely-payout',settled:true,source:'automatic-estimate',possiblePayoutIds:[],reasons:[],note:'',...extra});
test('a settled payout deduction automatically starts a zero-day cycle, including without an old checkpoint',()=>{
 const adjustment=deduction(),options={adjustments:[adjustment]};
  const result=flexPayoutDays(account,[],[],now,options);
  assert.equal(result.days,0);assert.equal(result.remaining,5);assert.equal(result.reason,null);assert.equal(result.payoutResetAt,adjustment.to);
  assert.deepEqual(flexPayoutDays(account,[],[],now,options),result);
 for(const change of [{kind:'firm-adjustment' as const},{kind:'unexplained' as const},{settlementOffsetId:'adjacent-credit'},{settled:false},{amount:2000},{amount:NaN},{amount:null},{account:'another'},{to:'invalid'},{to:'2026-10-20T15:00:00Z'}]){
  const result=flexPayoutDays(account,[],[],now,{adjustments:[deduction(change)]});assert.equal(result.days,0);assert.equal(result.payoutResetAt,null);
 }
});
test('the newest observed deduction always determines the cycle even when a saved firm count is newer',()=>{
 const earlier=deduction({id:'earlier',to:'2026-10-19T13:00:00Z'}),latest=deduction();
 assert.equal(latestPayoutDeduction(account,[latest,earlier],now)?.id,latest.id);assert.equal(latestPayoutDeduction(account,[earlier,latest],now)?.id,latest.id);
 const reference=ref(4);reference.flex!.capturedAt='2026-10-19T15:30:00Z';
 const data:Journal={ready:true,trades:[],accounts:[],profiles:[],notes:[],cash:[],imports:[],lastSaved:stamp,seedVersion:'synthetic',realizedSessions:[],firmReferences:[reference],adjustments:[latest]};
 const result=accountFlexProgress(account,data,now)!.payout;assert.equal(result.days,0);assert.equal(result.payoutResetAt,latest.to);assert.equal(result.source,'payout');
});

test('pre-payout session profit is excluded and the count uses only the post-deduction split',()=>{
 const reset=deduction(),options={adjustments:[reset],sessions:[session(1010)],checkpoints:[capture(1000,10,{capturedAt:reset.to})]};
 const result=flexPayoutDays(account,[trade(1010)],[],now,options);
 assert.equal(result.days,0);assert.equal(result.today,10);
 assert.equal(flexPayoutDays(account,[],[],now,{...options,checkpoints:[capture(null,150,{capturedAt:reset.to,coverageIssues:1})]}).days,1);
 assert.equal(flexPayoutDays(account,[],[],now,{...options,checkpoints:[]}).reason,'baseline');
 const later=Date.parse('2026-10-21T16:00:00Z');
 const advanced=flexPayoutDays(account,[],[],later,{...options,sessions:[...options.sessions,session(150,'2026-10-20'),session(149.99,'2026-10-21')]});
 assert.equal(advanced.days,1);assert.equal(advanced.remaining,4);
});
test('partial exits spanning the deduction count their realized profit after the cut and entry fees stay at entry time',()=>{
 const reset=deduction();
 const fill=(id:string,side:'Buy'|'Sell',qty:number,price:number,pos:number,time:string):Fill=>({id,side,qty,price,pos,time,contract:'MNQ 2026-12',symbol:'MNQ',pv:2,ordinal:Number(id)});
 const source=[fill('1','Buy',2,100,2,'2026-10-19T14:00:00Z'),fill('2','Sell',1,200,1,reset.to),fill('3','Sell',1,175.25,0,'2026-10-19T15:01:00Z')];
 const events=realizedEvents(account,source),options={adjustments:[reset],sessions:aggregateRealized(events,'session'),checkpoints:[realizedCheckpoint(account,reset.to,events)]};
 assert.equal(options.checkpoints[0].net,198.5);assert.equal(options.checkpoints[0].afterNet,150);
 const result=flexPayoutDays(account,[],[],now,options);assert.equal(result.days,1);assert.equal(result.today,150);
 const withEntry=realizedEvents(account,[...source,fill('4','Buy',1,175,1,'2026-10-19T15:02:00Z')]);
 const lowered=flexPayoutDays(account,[],[],now,{adjustments:[reset],sessions:aggregateRealized(withEntry,'session'),checkpoints:[realizedCheckpoint(account,reset.to,withEntry)]});
 assert.equal(lowered.days,0);assert.equal(lowered.today,149.5);
});
test('post-payout coverage and costs stay unknown unless five later known qualifying sessions settle the count',()=>{
 const reset=deduction(),options={adjustments:[reset],sessions:[session(null)],checkpoints:[capture(200,null,{capturedAt:reset.to})]};
 assert.equal(flexPayoutDays(account,[],[],now,options).reason,'costs');
 assert.equal(flexPayoutDays(account,[],[],now,{...options,checkpoints:[{...options.checkpoints[0],afterCoverageIssues:1}]}).reason,'coverage');
 const five=['2026-10-20','2026-10-21','2026-10-22','2026-10-23','2026-10-26'].map(day=>session(150,day));
 assert.equal(flexPayoutDays(account,[],[],Date.parse('2026-10-26T16:00:00Z'),{...options,sessions:[...options.sessions,...five]}).days,5);
 const next=deduction({id:'next-payout',to:'2026-10-27T00:00:00Z'});
 assert.equal(flexPayoutDays(account,[],[],Date.parse('2026-10-27T16:00:00Z'),{...options,sessions:five,adjustments:[reset,next]}).days,0);
});
test('saved records linked to the detected payout do not demand another cycle check, while a genuinely later unobserved payout does',()=>{
 const payout:CashRecord={id:'saved',account,kind:'payout',date:'2026-10-19',deduction:2000,received:null,expense:null,note:'',firmPayout:{firm:'Lucid',currency:'USD',amount:2000,requestedDate:'2026-10-18',approvedDate:'2026-10-19',status:'Paid',source:'Synthetic record'}};
 for(const extra of [{payoutId:payout.id,kind:'payout' as const},{possiblePayoutIds:[payout.id]}]){
  const reset=deduction(extra),result=flexPayoutDays(account,[],[payout],now,{adjustments:[reset]});assert.equal(result.days,0);
 }
 const reset=deduction({payoutId:payout.id}),later={...payout,id:'later',payoutApprovalAt:'2026-10-19T15:30:00Z'};
 assert.equal(flexPayoutDays(account,[],[payout,later],now,{adjustments:[reset]}).reason,'payout');
 assert.equal(flexPayoutDays(account,[],[{...later,payoutApprovalAt:'2026-10-19T17:00:00Z'}],now,{adjustments:[reset]}).days,0);
 assert.equal(flexPayoutDays(account,[],[{...payout,id:'ambiguous'}],now,{adjustments:[reset]}).reason,'approval-time');
});
test('amount/date overlap links cannot hide a known later approval',()=>{
 const payout:CashRecord={id:'linked-later',account,kind:'payout',date:'2026-10-19',deduction:2000,received:null,expense:null,note:'',payoutApprovalAt:'2026-10-19T15:45:00Z'};
 for(const extra of [{payoutId:payout.id,kind:'payout' as const},{possiblePayoutIds:[payout.id]}]){
  const options={adjustments:[deduction(extra)]};assert.equal(flexPayoutDays(account,[],[payout],now,options).reason,'payout');
  assert.equal(flexPayoutDays(account,[],[{...payout,payoutApprovalAt:'2026-10-19T14:55:00Z'}],now,options).days,0);
 }
});

test('earlier observed payouts on the same date do not invalidate the latest reset without inventing additional cycles',()=>{
 const record=(id:string):CashRecord=>({id,account,kind:'payout',date:'2026-10-19',deduction:2000,received:null,expense:null,note:'',firmPayout:{firm:'Lucid',currency:'USD',amount:2000,requestedDate:'2026-10-18',approvedDate:'2026-10-19',status:'Paid',source:'Synthetic record'}});
 const cash=[record('old'),record('new')],adjustments=[deduction({id:'earlier',to:'2026-10-19T14:30:00Z',payoutId:'old'}),deduction({payoutId:'new'})];
 assert.equal(flexPayoutDays(account,[],cash,now,{adjustments}).days,0);
 assert.equal(flexPayoutDays(account,[],cash,now,{adjustments}).days,0);
 const later=cash.map(row=>({...row,payoutApprovalAt:'2026-10-19T15:45:00Z'}));
 assert.equal(flexPayoutDays(account,[],later,now,{adjustments}).reason,'payout');
});
test('fresh funded accounts count one day per qualifying session without any manual starting record',()=>{
 const result=flexPayoutDays(account,[],[],Date.parse('2026-10-21T16:00:00Z'),{sessions:[session(75),{...session(75),contract:'MES 2026-12',symbol:'MES'},session(149.99,'2026-10-20'),session(150,'2026-10-21')]});
 assert.equal(result.days,2);assert.equal(result.remaining,3);assert.equal(result.cycleProfit,449.99);assert.equal(result.source,'funded-start');
 const empty=flexPayoutDays(account,[],[],now,{sessions:[]});assert.equal(empty.days,0);assert.equal(empty.cycleProfit,0);
});
test('cycle profit restarts after a payout while the saved drawdown floor remains independent',()=>{
 const reference={...ref(5),minimumBalance:50100},before=JSON.stringify(reference),reset=deduction();
 const progress=flexPayoutDays(account,[],[],Date.parse('2026-10-20T16:00:00Z'),{adjustments:[reset],sessions:[session(2000),session(160,'2026-10-20')],checkpoints:[capture(1900,100,{capturedAt:reset.to})]});
 assert.equal(progress.days,1);assert.equal(progress.cycleProfit,260);assert.equal(JSON.stringify(reference),before);
});

test('unobserved approvals in the early evening portion of the first trading day remain explicit, even with empty history',()=>{
 const cash:CashRecord={id:'early-evening',account,kind:'payout',date:'2026-10-19',deduction:2000,received:null,expense:null,note:'',payoutApprovalAt:'2026-10-19T23:30:00Z'};
 const at=Date.parse('2026-10-20T16:00:00Z');
 const result=flexPayoutDays(account,[],[cash],at,{sessions:[session(500,'2026-10-20')]});assert.equal(result.reason,'payout');assert.equal(result.days,null);assert.equal(result.cycleProfit,null);
 assert.equal(flexPayoutDays(account,[],[cash],at,{sessions:[]}).reason,'payout');
});

test('historical firm counts never certify a missing payout reset',()=>{
 const payout:CashRecord={id:'known-old',account,kind:'payout',date:'2026-10-19',deduction:2000,received:null,expense:null,note:'',payoutApprovalAt:'2026-10-19T13:00:00Z'};
 const reference=ref(5,1000);reference.flex!.coveredPayoutIds=[payout.id];
 const data:Journal={ready:true,trades:[],accounts:[],profiles:[],notes:[],cash:[payout],imports:[],lastSaved:stamp,seedVersion:'synthetic',realizedSessions:[session(1000,'2026-10-16'),session(160,'2026-10-20')],firmReferences:[reference]};
 const result=accountFlexProgress(account,data,Date.parse('2026-10-20T16:00:00Z'))!.payout;assert.equal(result.days,null);assert.equal(result.cycleProfit,null);assert.equal(result.reason,'payout');
});

test('future payout evidence never hides a current fresh-cycle profit or requires a starting record',()=>{
 const payout:CashRecord={id:'future-fresh',account,kind:'payout',date:'2026-10-20',deduction:2000,received:null,expense:null,note:''};
 for(const future of [payout,{...payout,date:'2026-10-19',payoutApprovalAt:'2026-10-20T15:00:00Z'},{...payout,date:'2026-10-19',firmPayout:{firm:'Lucid',currency:'USD' as const,amount:2000,requestedDate:'2026-10-19',approvedDate:'2026-10-20',status:'Paid' as const,source:'Synthetic future'}}]){
  const empty=flexPayoutDays(account,[],[future],now,{sessions:[]});assert.equal(empty.days,0);assert.equal(empty.cycleProfit,0);
  const current=flexPayoutDays(account,[],[future],now,{sessions:[session(160)]});assert.equal(current.days,1);assert.equal(current.cycleProfit,160);
 }
});

test('a payout observed after intervening trading preserves a confirmed-day lower bound without inventing the posting time',()=>{
 const reset=deduction({from:'2026-10-17T15:00:00Z',to:'2026-10-19T15:00:00Z',tradingActivity:true,tradingNet:800});
 const options={adjustments:[reset],sessions:[session(200,'2026-10-20')],checkpoints:[capture(800,0,{capturedAt:reset.to})]};
 const progress=flexPayoutDays(account,[],[],Date.parse('2026-10-20T16:00:00Z'),options);
 assert.equal(progress.days,null);assert.equal(progress.confirmedDays,1);assert.equal(progress.remaining,null);assert.equal(progress.reason,'payout-time');assert.equal(progress.cycleProfit,null);
 assert.equal(flexPayoutDays(account,[],[],Date.parse('2026-10-20T16:00:00Z'),{...options,adjustments:[{...reset,tradingNet:0}]}).reason,'payout-time');
 assert.equal(flexPayoutDays(account,[],[],Date.parse('2026-10-20T16:00:00Z'),{...options,adjustments:[{...reset,tradingActivity:false,tradingNet:0}]}).days,1);
 const official=ref(2,200);official.date='2026-10-20';official.flex!.capturedAt='2026-10-20T15:30:00Z';
 const corrected=flexPayoutDays(account,[],[],Date.parse('2026-10-20T16:00:00Z'),{...options,checkpoints:[...options.checkpoints,capture(200,0,{capturedAt:official.flex!.capturedAt,session:'2026-10-20'})]});
 assert.equal(corrected.days,null);assert.equal(corrected.source,'payout');assert.equal(corrected.cycleProfit,null);
 const laterDays=Array.from({length:5},(_,i)=>session(160,'2026-10-'+String(20+i)));
 assert.equal(flexPayoutDays(account,[],[],Date.parse('2026-10-24T16:00:00Z'),{...options,sessions:laterDays}).days,5);
});
