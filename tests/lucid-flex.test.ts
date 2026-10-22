import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Trade,AccountProfile,CashRecord,Fill} from '../lib/types';
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
test('funded checkpoints advance by net sessions, never by fills or duplicate refreshes, and current-session losses can undo a day',()=>{
 const checkpoint=ref(3,0),first=trade(75),second=trade(75,'2026-10-19T15:01:00Z','b');
 assert.equal(flexPayoutDays(account,[],checkpoint,[],now).days,3);
 assert.equal(flexPayoutDays(account,[first],checkpoint,[],now).days,3);
 const result=flexPayoutDays(account,[first,second],checkpoint,[],now);assert.equal(result.days,4);assert.equal(result.remaining,1);assert.equal(result.estimated,true);assert.equal(result.today,150);
 assert.equal(flexPayoutDays(account,[first,second],checkpoint,[],now).days,4);
 assert.equal(flexPayoutDays(account,[first,second,trade(-1,'2026-10-19T15:02:00Z','loss')],checkpoint,[],now).days,3);
 assert.equal(flexPayoutDays(account,[{...first,account:'LFF05000000000019'}],checkpoint,[],now).days,3);
 const earlier=trade(150,'2026-10-19T14:00:00Z');assert.equal(flexPayoutDays(account,[earlier,trade(-1)],ref(4),[],now).days,3);
});
test('cash amounts alone cannot locate a reset; later approvals without observed deductions remain unknown',()=>{
 const payout:CashRecord={id:'p',account,kind:'payout',date:'2026-10-19',deduction:1000,received:900,expense:null,note:''};
 const result=flexPayoutDays(account,[],ref(),[payout],now);assert.equal(result.days,3);assert.equal(result.reason,null);
 const oldApproval={...payout,firmPayout:{firm:'Lucid',currency:'USD' as const,amount:1000,requestedDate:'2026-10-15',approvedDate:'2026-10-16',status:'Paid' as const,source:'Owner record'}};
 assert.equal(flexPayoutDays(account,[],ref(),[oldApproval],now).days,3);
 const approved={...oldApproval,payoutApprovalAt:'2026-10-19T15:00:00Z'};
 assert.equal(flexPayoutDays(account,[],ref(),[approved],now).reason,'payout');
 assert.equal(flexPayoutDays(account,[],ref(),[{...approved,payoutApprovalAt:'2026-10-19T14:00:00Z'}],now).days,3);
 const nextDay=Date.parse('2026-10-20T16:00:00Z'),later={...oldApproval,firmPayout:{...oldApproval.firmPayout,approvedDate:'2026-10-20'}};
 assert.equal(flexPayoutDays(account,[],ref(),[later],nextDay).reason,'payout');
 assert.equal(flexPayoutDays(account,[],ref(),[later],now).days,3);
});
test('unknown new costs and missing checkpoints keep uncertainty explicit',()=>{
 const unknown=flexPayoutDays(account,[{...trade(150),symbol:'GC'}],ref(),[],now);assert.equal(unknown.days,null);assert.equal(unknown.reason,'costs');
 assert.equal(flexPayoutDays(account,[],undefined,[],now).days,0);
 assert.equal(flexPayoutDays(account,[trade(150)],ref(5),[],now).days,5);
});
test('firm day checkpoints validate independently of money and reject inconsistent stages, counts and timestamps',()=>{
 const r=ref(0);assert.equal(r.flex?.qualifyingDays,0);assert.equal(r.balance,null);assert.equal(r.totalProfit,null);
 for(const bad of [{qualifyingDays:6},{qualifyingDays:-1},{qualifyingDays:1.5},{consistencyPercent:50},{stage:'Evaluation'},{capturedAt:'2026-02-30T14:17:43Z'},{capturedAt:'2099-10-19T14:17:43Z'}])assert.throws(()=>validateFirmReference({...r,flex:{...r.flex,...bad}}));
 assert.throws(()=>validateFirmReference({...r,account:'LFF-UNKNOWN'}));
});
test('official checkpoint session P&L plus a later loss can undo a counted day without any pre-checkpoint fills',()=>{
 const options={sessions:[session(-100)],checkpoints:[capture(null,-100)]},result=flexPayoutDays(account,[],ref(3,200),[],now,options);
 assert.equal(result.days,2);assert.equal(result.remaining,3);assert.equal(result.today,100);assert.equal(result.reason,null);assert.equal(result.estimated,true);
 const gains=flexPayoutDays(account,[],ref(3,100),[],now,{sessions:[session(75)],checkpoints:[capture(null,75)]});assert.equal(gains.days,4);assert.equal(gains.today,175);
});
test('an unknown checkpoint session baseline is not silently treated as zero when it can change the count',()=>{
 const options={sessions:[session(150)],checkpoints:[capture(null,150)]},result=flexPayoutDays(account,[],ref(),[],now,options);
 assert.equal(result.days,null);assert.equal(result.reason,'baseline');assert.equal(result.today,null);
 assert.equal(flexPayoutDays(account,[],ref(),[],now,{sessions:[],checkpoints:[capture(null,0)]}).days,3);
 assert.equal(flexPayoutDays(account,[],ref(5),[],now,options).days,5);
 assert.equal(flexPayoutDays(account,[],ref(0),[],now,{sessions:[session(-100)],checkpoints:[capture(null,-100)]}).days,0);
 assert.equal(flexPayoutDays(account,[trade(150)],ref(),[],now).reason,'baseline');
});
test('the compact ledger counts partial exits and entry commissions before a completed trade exists',()=>{
 const fill=(id:string,side:'Buy'|'Sell',qty:number,price:number,pos:number,time:string):Fill=>({id,side,qty,price,pos,time,contract:'MNQ 2026-12',symbol:'MNQ',pv:2,ordinal:Number(id)});
 const events=realizedEvents(account,[fill('1','Buy',2,100,2,'2026-10-19T14:00:00Z'),fill('2','Sell',1,200,1,'2026-10-19T15:00:00Z')]),options={sessions:aggregateRealized(events,'session'),checkpoints:[realizedCheckpoint(account,stamp,events)]};
 assert.deepEqual(flexDaily([],options),[{day:'2026-10-19',net:198.5}]);assert.equal(flexEvaluation([],50,options).net,198.5);
 assert.equal(flexPayoutDays(account,[],ref(),[],now,options).days,4);
 const entryOnly=realizedEvents(account,[fill('3','Buy',2,100,2,'2026-10-19T15:00:00Z')]),entryOptions={sessions:aggregateRealized(entryOnly,'session'),checkpoints:[realizedCheckpoint(account,stamp,entryOnly)]};
 const afterEntry=flexPayoutDays(account,[],ref(3,150),[],now,entryOptions);assert.equal(afterEntry.days,2);assert.equal(afterEntry.today,149);
 assert.equal(flexEvaluation([trade(500)],50,{sessions:[]}).net,null);
});
test('known official baseline bypasses older ledger gaps while new coverage and fees remain separate uncertainties',()=>{
 const options={sessions:[session(null)],checkpoints:[capture(null,200,{coverageIssues:1})]};
 assert.equal(flexPayoutDays(account,[],ref(3,0),[],now,options).days,4);
 const missing=flexPayoutDays(account,[],ref(3,0),[],now,{sessions:[{...session(null),commissions:1,coverageIssues:1}],checkpoints:[capture(0,null,{afterCoverageIssues:1})]});
 assert.equal(missing.days,null);assert.equal(missing.reason,'coverage');
 const fees=flexPayoutDays(account,[],ref(3,0),[],now,{sessions:[session(null)],checkpoints:[capture(0,null)]});assert.equal(fees.reason,'costs');
});
test('same-day date-only approvals are ambiguous until a checkpoint explicitly includes the payout',()=>{
 const payout:CashRecord={id:'approved-same-day',account,kind:'payout',date:'2026-10-19',deduction:null,received:null,expense:null,note:'',firmPayout:{firm:'Lucid',currency:'USD',amount:1000,requestedDate:'2026-10-18',approvedDate:'2026-10-19',status:'Paid',source:'Owner record'}};
 const result=flexPayoutDays(account,[],ref(),[payout],now);assert.equal(result.days,null);assert.equal(result.reason,'approval-time');
 const checkpoint=ref();checkpoint.flex!.coveredPayoutIds=[payout.id];assert.equal(flexPayoutDays(account,[],checkpoint,[payout],now).days,3);
 assert.equal(flexPayoutDays(account,[],ref(),[{...payout,payoutApprovalAt:'2026-10-19T14:00:00Z'}],now).days,3);
});
test('future trades, sessions and exact approval timestamps do not advance or reset the current count',()=>{
 const tomorrow=trade(150,'2026-10-20T15:00:00Z'),futureApproval:CashRecord={id:'future',account,kind:'payout',date:'2026-10-19',deduction:null,received:null,expense:null,note:'',payoutApprovalAt:'2026-10-19T18:00:00Z'};
 assert.equal(flexPayoutDays(account,[tomorrow],ref(),[futureApproval],now).days,3);
 assert.equal(flexPayoutDays(account,[],ref(),[],now,{sessions:[session(150,'2026-10-20')],checkpoints:[capture(null,0)]}).days,3);
});
const deduction=(extra:Partial<BalanceAdjustment>={}):BalanceAdjustment=>({id:'new-deduction',account,date:'2026-10-19',from:'2026-10-19T14:59:00Z',to:'2026-10-19T15:00:00Z',before:54000,after:52000,tradingNet:0,amount:-2000,kind:'likely-payout',settled:true,source:'automatic-estimate',possiblePayoutIds:[],reasons:[],note:'',...extra});
test('a settled payout deduction automatically starts a zero-day cycle, including without an old checkpoint',()=>{
 const adjustment=deduction(),options={adjustments:[adjustment]};
 for(const reference of [ref(5),undefined]){
  const result=flexPayoutDays(account,[],reference,[],now,options);
  assert.equal(result.days,0);assert.equal(result.remaining,5);assert.equal(result.reason,null);assert.equal(result.payoutResetAt,adjustment.to);assert.equal(result.estimated,true);
  assert.deepEqual(flexPayoutDays(account,[],reference,[],now,options),result);
 }
 for(const change of [{kind:'firm-adjustment' as const},{kind:'unexplained' as const},{settlementOffsetId:'adjacent-credit'},{settled:false},{amount:2000},{amount:NaN},{amount:null},{account:'another'},{to:'invalid'},{to:'2026-10-20T15:00:00Z'}]){
  const result=flexPayoutDays(account,[],ref(5),[],now,{adjustments:[deduction(change)]});assert.equal(result.days,5);assert.equal(result.payoutResetAt,null);
 }
});
test('the newest observed payout wins and a newer known funded checkpoint can supersede it',()=>{
 const earlier=deduction({id:'earlier',to:'2026-10-19T13:00:00Z'}),latest=deduction();
 assert.equal(latestPayoutDeduction(account,[latest,earlier],now)?.id,latest.id);
 assert.equal(latestPayoutDeduction(account,[earlier,latest],now)?.id,latest.id);
 const checkpoint=ref(2);checkpoint.flex!.capturedAt='2026-10-19T15:30:00Z';
 assert.equal(flexPayoutDays(account,[],checkpoint,[],now,{adjustments:[latest]}).days,2);
 assert.equal(flexPayoutDays(account,[],checkpoint,[],now,{adjustments:[latest]}).payoutResetAt,null);
 checkpoint.flex!.qualifyingDays=null;assert.equal(flexPayoutDays(account,[],checkpoint,[],now,{adjustments:[latest]}).days,0);
 checkpoint.flex!.stage='Evaluation';assert.equal(flexPayoutDays(account,[],checkpoint,[],now,{adjustments:[latest]}).days,0);
 checkpoint.flex!.stage='Funded';checkpoint.flex!.qualifyingDays=4;checkpoint.flex!.capturedAt='2026-10-19T18:00:00Z';
 assert.equal(flexPayoutDays(account,[],checkpoint,[],now,{adjustments:[latest]}).days,0);
 assert.equal(flexPayoutDays(account,[],checkpoint,[],now).days,0);
});
test('pre-payout session profit is excluded and the count uses only the post-deduction split',()=>{
 const reset=deduction(),options={adjustments:[reset],sessions:[session(1010)],checkpoints:[capture(1000,10,{capturedAt:reset.to})]};
 const result=flexPayoutDays(account,[trade(1010)],ref(5),[],now,options);
 assert.equal(result.days,0);assert.equal(result.today,10);
 assert.equal(flexPayoutDays(account,[],ref(5),[],now,{...options,checkpoints:[capture(null,150,{capturedAt:reset.to,coverageIssues:1})]}).days,1);
 assert.equal(flexPayoutDays(account,[],ref(5),[],now,{...options,checkpoints:[]}).reason,'baseline');
 const later=Date.parse('2026-10-21T16:00:00Z');
 const advanced=flexPayoutDays(account,[],ref(5),[],later,{...options,sessions:[...options.sessions,session(150,'2026-10-20'),session(149.99,'2026-10-21')]});
 assert.equal(advanced.days,1);assert.equal(advanced.remaining,4);
});
test('partial exits spanning the deduction count their realized profit after the cut and entry fees stay at entry time',()=>{
 const reset=deduction();
 const fill=(id:string,side:'Buy'|'Sell',qty:number,price:number,pos:number,time:string):Fill=>({id,side,qty,price,pos,time,contract:'MNQ 2026-12',symbol:'MNQ',pv:2,ordinal:Number(id)});
 const source=[fill('1','Buy',2,100,2,'2026-10-19T14:00:00Z'),fill('2','Sell',1,200,1,reset.to),fill('3','Sell',1,175.25,0,'2026-10-19T15:01:00Z')];
 const events=realizedEvents(account,source),options={adjustments:[reset],sessions:aggregateRealized(events,'session'),checkpoints:[realizedCheckpoint(account,reset.to,events)]};
 assert.equal(options.checkpoints[0].net,198.5);assert.equal(options.checkpoints[0].afterNet,150);
 const result=flexPayoutDays(account,[],undefined,[],now,options);assert.equal(result.days,1);assert.equal(result.today,150);
 const withEntry=realizedEvents(account,[...source,fill('4','Buy',1,175,1,'2026-10-19T15:02:00Z')]);
 const lowered=flexPayoutDays(account,[],undefined,[],now,{adjustments:[reset],sessions:aggregateRealized(withEntry,'session'),checkpoints:[realizedCheckpoint(account,reset.to,withEntry)]});
 assert.equal(lowered.days,0);assert.equal(lowered.today,149.5);
});
test('post-payout coverage and costs stay unknown unless five later known qualifying sessions settle the count',()=>{
 const reset=deduction(),options={adjustments:[reset],sessions:[session(null)],checkpoints:[capture(200,null,{capturedAt:reset.to})]};
 assert.equal(flexPayoutDays(account,[],ref(5),[],now,options).reason,'costs');
 assert.equal(flexPayoutDays(account,[],ref(5),[],now,{...options,checkpoints:[{...options.checkpoints[0],afterCoverageIssues:1}]}).reason,'coverage');
 const five=['2026-10-20','2026-10-21','2026-10-22','2026-10-23','2026-10-26'].map(day=>session(150,day));
 assert.equal(flexPayoutDays(account,[],ref(5),[],Date.parse('2026-10-26T16:00:00Z'),{...options,sessions:[...options.sessions,...five]}).days,5);
 const next=deduction({id:'next-payout',to:'2026-10-27T00:00:00Z'});
 assert.equal(flexPayoutDays(account,[],ref(5),[],Date.parse('2026-10-27T16:00:00Z'),{...options,sessions:five,adjustments:[reset,next]}).days,0);
});
test('saved records linked to the detected payout do not demand another cycle check, while a genuinely later unobserved payout does',()=>{
 const payout:CashRecord={id:'saved',account,kind:'payout',date:'2026-10-19',deduction:2000,received:null,expense:null,note:'',firmPayout:{firm:'Lucid',currency:'USD',amount:2000,requestedDate:'2026-10-18',approvedDate:'2026-10-19',status:'Paid',source:'Synthetic record'}};
 for(const extra of [{payoutId:payout.id,kind:'payout' as const},{possiblePayoutIds:[payout.id]}]){
  const reset=deduction(extra),result=flexPayoutDays(account,[],ref(5),[payout],now,{adjustments:[reset]});assert.equal(result.days,0);
  const reference=ref(1);reference.flex!.capturedAt='2026-10-19T15:30:00Z';assert.equal(flexPayoutDays(account,[],reference,[payout],now,{adjustments:[reset]}).days,1);
 }
 const reset=deduction({payoutId:payout.id}),later={...payout,id:'later',payoutApprovalAt:'2026-10-19T15:30:00Z'};
 assert.equal(flexPayoutDays(account,[],ref(5),[payout,later],now,{adjustments:[reset]}).reason,'payout');
 assert.equal(flexPayoutDays(account,[],ref(5),[{...later,payoutApprovalAt:'2026-10-19T17:00:00Z'}],now,{adjustments:[reset]}).days,0);
 assert.equal(flexPayoutDays(account,[],ref(5),[{...payout,id:'ambiguous'}],now,{adjustments:[reset]}).reason,'approval-time');
});
test('amount/date overlap links cannot hide a known later approval, while explicit checkpoint coverage remains authoritative',()=>{
 const payout:CashRecord={id:'linked-later',account,kind:'payout',date:'2026-10-19',deduction:2000,received:null,expense:null,note:'',payoutApprovalAt:'2026-10-19T15:45:00Z'};
 for(const extra of [{payoutId:payout.id,kind:'payout' as const},{possiblePayoutIds:[payout.id]}]){
  const reset=deduction(extra),options={adjustments:[reset]};
  assert.equal(flexPayoutDays(account,[],ref(5),[payout],now,options).reason,'payout');
  const checkpoint=ref(1);checkpoint.flex!.capturedAt='2026-10-19T15:30:00Z';
  assert.equal(flexPayoutDays(account,[],checkpoint,[payout],now,options).reason,'payout');
  checkpoint.flex!.coveredPayoutIds=[payout.id];assert.equal(flexPayoutDays(account,[],checkpoint,[payout],now,options).days,1);
  assert.equal(flexPayoutDays(account,[],ref(5),[{...payout,payoutApprovalAt:'2026-10-19T14:55:00Z'}],now,options).days,0);
 }
});
test('earlier observed payouts on the same date do not invalidate the latest reset or a newer firm checkpoint',()=>{
 const record=(id:string):CashRecord=>({id,account,kind:'payout',date:'2026-10-19',deduction:2000,received:null,expense:null,note:'',firmPayout:{firm:'Lucid',currency:'USD',amount:2000,requestedDate:'2026-10-18',approvedDate:'2026-10-19',status:'Paid',source:'Synthetic record'}});
 const cash=[record('old'),record('new')],adjustments=[deduction({id:'earlier',to:'2026-10-19T14:30:00Z',payoutId:'old'}),deduction({payoutId:'new'})];
 assert.equal(flexPayoutDays(account,[],ref(5),cash,now,{adjustments}).days,0);
 const checkpoint=ref(1);checkpoint.flex!.capturedAt='2026-10-19T15:30:00Z';assert.equal(flexPayoutDays(account,[],checkpoint,cash,now,{adjustments}).days,1);
 const later=cash.map(row=>({...row,payoutApprovalAt:'2026-10-19T15:45:00Z'}));
 assert.equal(flexPayoutDays(account,[],checkpoint,later,now,{adjustments}).reason,'payout');
});
test('fresh funded accounts count one day per qualifying session without any manual starting record',()=>{
 const result=flexPayoutDays(account,[],undefined,[],Date.parse('2026-10-21T16:00:00Z'),{sessions:[session(75),{...session(75),contract:'MES 2026-12',symbol:'MES'},session(149.99,'2026-10-20'),session(150,'2026-10-21')]});
 assert.equal(result.days,2);assert.equal(result.remaining,3);assert.equal(result.cycleProfit,449.99);assert.equal(result.source,'funded-start');
 const empty=flexPayoutDays(account,[],undefined,[],now,{sessions:[]});assert.equal(empty.days,0);assert.equal(empty.cycleProfit,0);
});
test('cycle profit restarts after a payout while the saved drawdown floor remains independent',()=>{
 const reference={...ref(5),minimumBalance:50100},before=JSON.stringify(reference),reset=deduction();
 const progress=flexPayoutDays(account,[],reference,[],Date.parse('2026-10-20T16:00:00Z'),{adjustments:[reset],sessions:[session(2000),session(160,'2026-10-20')],checkpoints:[capture(1900,100,{capturedAt:reset.to})]});
 assert.equal(progress.days,1);assert.equal(progress.cycleProfit,260);assert.equal(JSON.stringify(reference),before);
});

test('unobserved approvals in the early evening portion of the first trading day remain explicit, even with empty history',()=>{
 const cash:CashRecord={id:'early-evening',account,kind:'payout',date:'2026-10-19',deduction:2000,received:null,expense:null,note:'',payoutApprovalAt:'2026-10-19T23:30:00Z'};
 const at=Date.parse('2026-10-20T16:00:00Z');
 const result=flexPayoutDays(account,[],undefined,[cash],at,{sessions:[session(500,'2026-10-20')]});assert.equal(result.reason,'payout');assert.equal(result.days,null);assert.equal(result.cycleProfit,null);
 assert.equal(flexPayoutDays(account,[],undefined,[cash],at,{sessions:[]}).reason,'payout');
});

test('an official day-count correction does not certify a missing payout-cycle profit baseline',()=>{
 const payout:CashRecord={id:'known-old',account,kind:'payout',date:'2026-10-19',deduction:2000,received:null,expense:null,note:'',payoutApprovalAt:'2026-10-19T13:00:00Z'};
 const reference=ref(0,0);reference.flex!.coveredPayoutIds=[payout.id];
 const result=flexPayoutDays(account,[],reference,[payout],Date.parse('2026-10-20T16:00:00Z'),{sessions:[session(1000,'2026-10-16'),session(160,'2026-10-20')],checkpoints:[capture(0,0)]});
 assert.equal(result.days,1);assert.equal(result.cycleProfit,null);
 const later={...payout,payoutApprovalAt:'2026-10-19T15:15:00Z'},reset=deduction();reference.flex!.capturedAt='2026-10-19T15:30:00Z';
 const withEarlierReset=flexPayoutDays(account,[],reference,[later],Date.parse('2026-10-20T16:00:00Z'),{adjustments:[reset],sessions:[session(160,'2026-10-20')],checkpoints:[capture(0,0,{capturedAt:reference.flex!.capturedAt})]});
 assert.equal(withEarlierReset.days,1);assert.equal(withEarlierReset.cycleProfit,null);
});

test('future payout evidence never hides a current fresh-cycle profit or requires a starting record',()=>{
 const payout:CashRecord={id:'future-fresh',account,kind:'payout',date:'2026-10-20',deduction:2000,received:null,expense:null,note:''};
 for(const future of [payout,{...payout,date:'2026-10-19',payoutApprovalAt:'2026-10-20T15:00:00Z'},{...payout,date:'2026-10-19',firmPayout:{firm:'Lucid',currency:'USD' as const,amount:2000,requestedDate:'2026-10-19',approvedDate:'2026-10-20',status:'Paid' as const,source:'Synthetic future'}}]){
  const empty=flexPayoutDays(account,[],undefined,[future],now,{sessions:[]});assert.equal(empty.days,0);assert.equal(empty.cycleProfit,0);
  const current=flexPayoutDays(account,[],undefined,[future],now,{sessions:[session(160)]});assert.equal(current.days,1);assert.equal(current.cycleProfit,160);
 }
});

test('a payout observed after intervening trading preserves a confirmed-day lower bound without inventing the posting time',()=>{
 const reset=deduction({from:'2026-10-17T15:00:00Z',to:'2026-10-19T15:00:00Z',tradingActivity:true,tradingNet:800});
 const options={adjustments:[reset],sessions:[session(200,'2026-10-20')],checkpoints:[capture(800,0,{capturedAt:reset.to})]};
 const progress=flexPayoutDays(account,[],undefined,[],Date.parse('2026-10-20T16:00:00Z'),options);
 assert.equal(progress.days,null);assert.equal(progress.confirmedDays,1);assert.equal(progress.remaining,null);assert.equal(progress.reason,'payout-time');assert.equal(progress.cycleProfit,null);
 assert.equal(flexPayoutDays(account,[],undefined,[],Date.parse('2026-10-20T16:00:00Z'),{...options,adjustments:[{...reset,tradingNet:0}]}).reason,'payout-time');
 assert.equal(flexPayoutDays(account,[],undefined,[],Date.parse('2026-10-20T16:00:00Z'),{...options,adjustments:[{...reset,tradingActivity:false,tradingNet:0}]}).days,1);
 const official=ref(2,200);official.date='2026-10-20';official.flex!.capturedAt='2026-10-20T15:30:00Z';
 const corrected=flexPayoutDays(account,[],official,[],Date.parse('2026-10-20T16:00:00Z'),{...options,checkpoints:[...options.checkpoints,capture(200,0,{capturedAt:official.flex!.capturedAt,session:'2026-10-20'})]});
 assert.equal(corrected.days,2);assert.equal(corrected.source,'firm-checkpoint');assert.equal(corrected.cycleProfit,null);
 const laterDays=Array.from({length:5},(_,i)=>session(160,'2026-10-'+String(20+i)));
 assert.equal(flexPayoutDays(account,[],undefined,[],Date.parse('2026-10-24T16:00:00Z'),{...options,sessions:laterDays}).days,5);
});
