import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Trade,AccountProfile,CashRecord,Fill} from '../lib/types';
import {validateFirmReference} from '../lib/firm-reference';
import {accountStage,flexAccount,flexDaily,flexEvaluation,flexPayoutDays,flexSession} from '../lib/lucid-flex';
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
test('only confirmed later approvals invalidate a checkpoint; cash dates and deductions do not reset days',()=>{
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
 assert.equal(flexPayoutDays(account,[],undefined,[],now).days,null);
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
test('a new likely payout suspends the old cycle count without inventing an approval or reset',()=>{
 const adjustment:BalanceAdjustment={id:'new-deduction',account,date:'2026-10-19',from:'2026-10-19T14:59:00Z',to:'2026-10-19T15:00:00Z',before:54000,after:52000,tradingNet:0,amount:-2000,kind:'likely-payout',settled:true,source:'automatic-estimate',possiblePayoutIds:[],reasons:[],note:''};
 const result=flexPayoutDays(account,[],ref(5),[],now,{adjustments:[adjustment]});assert.equal(result.days,null);assert.equal(result.reason,'possible-payout');
 for(const change of [{...adjustment,kind:'firm-adjustment' as const},{...adjustment,settled:false},{...adjustment,to:'2026-10-19T14:00:00Z'},{...adjustment,account:'another'},{...adjustment,to:'2026-10-20T15:00:00Z'}])assert.equal(flexPayoutDays(account,[],ref(5),[],now,{adjustments:[change]}).days,5);
 const newCheckpoint=ref(0);newCheckpoint.flex!.capturedAt='2026-10-19T15:30:00Z';assert.equal(flexPayoutDays(account,[],newCheckpoint,[],now,{adjustments:[adjustment]}).days,0);
});
