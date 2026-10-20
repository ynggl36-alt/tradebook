import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accountCardGroups} from '../lib/account-display';
import type {AccountState} from '../lib/account-state';
import type {AccountProfile,Journal} from '../lib/types';
import {validateFirmReference} from '../lib/firm-reference';
import type {RealizedDay} from '../lib/realized';

const now=Date.parse('2026-10-20T18:00:00.000Z'),capturedAt='2026-10-19T14:00:00.000Z';
const funded=(suffix:string)=>'LFF05000000000'+suffix;
const evaluation=(suffix:string)=>'LFE05000000000'+suffix;
function state(account:string):AccountState{return {account,currency:'USD',connected:true,connection:'Synthetic',provider:'Synthetic',values:{},positions:[],positionsAt:capturedAt,positionsAvailable:true,capturedAt};}
function journal():Journal{return {ready:true,trades:[],accounts:[],profiles:[],notes:[],cash:[],imports:[],lastSaved:capturedAt,seedVersion:'synthetic',firmReferences:[],realizedSessions:[],realizedCheckpoints:[]};}
function reference(account:string,days:number|null,stage:'Funded'|'Evaluation'='Funded',consistencyPercent:40|50|null=null){return validateFirmReference({account,firm:'Lucid Flex',date:'2026-10-19',currency:'USD',balance:50000,source:'Synthetic test checkpoint',flex:{stage,qualifyingDays:days,consistencyPercent,capturedAt}});}
function session(account:string,net:number,day:string):RealizedDay{return {account,contract:'MNQ 2026-12',symbol:'MNQ',day,gross:net+1,commissions:1,net,exits:1,quantity:1,unmatched:0};}
const ids=(group:ReturnType<typeof accountCardGroups>[number])=>group.accounts.map(row=>row.state.account);

test('funded order uses remaining qualifying days, puts unknown cycles last, and shares displayed progress',()=>{
 const data=journal(),far=funded('101'),near=funded('102'),goal=funded('103'),unknown=funded('104');
 data.firmReferences=[reference(far,1),reference(near,4),reference(goal,5)];
 const [group]=accountCardGroups([far,unknown,near,goal].map(state),data,new Map(),now);
 assert.deepEqual(ids(group),[goal,near,far,unknown]);
 assert.equal(group.accounts[0].progress?.payout.remaining,0);assert.equal(group.accounts[1].progress?.payout.remaining,1);assert.equal(group.accounts[3].progress?.payout.remaining,null);
});
test('a later approval removes an old day-goal account from the front without inventing a cycle reset',()=>{
 const data=journal(),reset=funded('101'),near=funded('102');data.firmReferences=[reference(reset,5),reference(near,4)];
 data.cash=[{id:'synthetic-approval',account:reset,kind:'payout',date:'2026-10-20',deduction:null,received:null,expense:null,note:'',payoutApprovalAt:'2026-10-20T14:00:00.000Z'}];
 const [group]=accountCardGroups([reset,near].map(state),data,new Map(),now);
 assert.deepEqual(ids(group),[near,reset]);assert.equal(group.accounts[1].progress?.payout.reason,'payout');assert.equal(group.accounts[1].progress?.payout.days,null);
});
test('evaluation order uses consistency-adjusted profit targets and leaves unconfirmed targets last',()=>{
 const data=journal(),near=evaluation('201'),adjusted=evaluation('202'),unconfirmed=evaluation('203');
 data.firmReferences=[reference(near,null,'Evaluation',50),reference(adjusted,null,'Evaluation',50),reference(unconfirmed,null,'Evaluation')];
 data.realizedSessions=[session(near,1250,'2026-10-19'),session(near,1250,'2026-10-20'),session(adjusted,2800,'2026-10-20'),session(unconfirmed,2990,'2026-10-20')];
 const [group]=accountCardGroups([unconfirmed,adjusted,near].map(state),data,new Map(),now);
 assert.deepEqual(ids(group),[near,adjusted,unconfirmed]);assert.equal(group.accounts[0].progress?.evaluation.remaining,500);assert.equal(group.accounts[1].progress?.evaluation.remaining,2800);
});
test('explicit stages win, unknown products stay unranked, and archived accounts follow active ones',()=>{
 const data=journal(),archived=funded('101'),active=funded('102'),overridden=funded('103'),unknown='SYNTHETIC-OTHER';
 data.firmReferences=[reference(archived,5),reference(active,1)];
 const profiles=new Map<string,AccountProfile>([[archived,{account:archived,label:'',stage:'Funded',status:'Failed',notes:''}],[overridden,{account:overridden,label:'',stage:'Evaluation',status:'Active',notes:''}]]);
 const groups=accountCardGroups([unknown,archived,overridden,active].map(state),data,profiles,now);
 assert.deepEqual(groups.map(group=>group.stage),['Funded','Evaluation','Unclassified']);assert.deepEqual(ids(groups[0]),[active,archived]);assert.deepEqual(ids(groups[1]),[overridden]);assert.deepEqual(ids(groups[2]),[unknown]);assert.equal(groups[2].accounts[0].progress,null);
});
