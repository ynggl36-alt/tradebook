import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accountAvailability,currentAccountSnapshot,monitorFresh,refreshAccountSnapshots,validateAccountState} from '../lib/account-state';
import type {AccountMonitor} from '../lib/account-state';
import {accountSyncStatus} from '../lib/recorder-status';
const capturedAt='2026-10-16T21:00:00.000Z',now=Date.parse(capturedAt);
function capture(){return {schemaVersion:1,mode:'AccountsReadOnly',recorderVersion:'0.3.0',capturedAt,running:true,scopePrefixes:['LFE','LFF'],accounts:[{account:'LFE-TEST',currency:'USD',connected:true,connection:'Prop connection',provider:'Rithmic',values:{CashValue:{value:51000,at:capturedAt,source:'PlatformRead'},UnrealizedProfitLoss:{value:0,at:capturedAt,source:'AccountItemUpdate'}},positionsAvailable:true,positions:[]}]};}
test('account snapshots distinguish missing provider data from a reported zero and preserve sources',()=>{
 const result=validateAccountState(capture(),now),account=result.accounts[0];
 assert.equal(account.values.CashValue?.value,51000);assert.equal(account.values.UnrealizedProfitLoss?.value,0);assert.equal(account.values.UnrealizedProfitLoss?.source,'AccountItemUpdate');assert.equal(account.values.NetLiquidation,undefined);assert.equal(account.positionsAt,capturedAt);
});
test('full snapshots never promote legacy merged fields or old positions into current readings',()=>{
 const account=validateAccountState(capture(),now).accounts[0],old='2026-10-15T21:00:00.000Z';
 const legacy={...account,values:{...account.values,RealizedProfitLoss:{value:933.25,at:old,source:'PlatformRead' as const}},positionsAvailable:true,positionsAt:old,positions:[{instrument:'MNQ 12-26',side:'Long' as const,quantity:2,averagePrice:100}]};
 const original=JSON.stringify(legacy),current=currentAccountSnapshot(legacy);
 assert.equal(current.values.CashValue?.value,51000);assert.equal(current.values.UnrealizedProfitLoss?.value,0);
 assert.equal(current.values.RealizedProfitLoss,undefined);assert.equal(current.positionsAvailable,false);assert.equal(current.positionsAt,null);assert.deepEqual(current.positions,[]);
 assert.equal(JSON.stringify(legacy),original);
 const disconnected=currentAccountSnapshot({...legacy,connected:false});assert.deepEqual(disconnected.values,{});assert.equal(disconnected.positionsAvailable,false);
});
test('refresh accepts changed account readings under an unchanged heartbeat and retains missing versus zero',()=>{
 const current=validateAccountState(capture(),now),monitor:AccountMonitor={capturedAt,running:true,recorderVersion:'0.5.0',scopePrefixes:['LFE'],accountsSeen:['LFE-TEST']};
 const previous={monitor,accounts:current.accounts},changed={monitor,accounts:[{...current.accounts[0],values:{...current.accounts[0].values,RealizedProfitLoss:{value:0,at:capturedAt,source:'PlatformRead' as const}}}]};
 const refreshed=refreshAccountSnapshots(previous,changed);assert.notEqual(refreshed,previous);assert.equal(refreshed.accounts[0].values.RealizedProfitLoss?.value,0);
 assert.equal(refreshAccountSnapshots(refreshed,changed),refreshed);
 const missing=refreshAccountSnapshots(refreshed,previous);assert.notEqual(missing,refreshed);assert.equal(missing.accounts[0].values.RealizedProfitLoss,undefined);
});
test('freshness stops treating snapshots as current after a stop, delay, removal or disconnection',()=>{
 const result=validateAccountState(capture(),now),account=result.accounts[0];const monitor:AccountMonitor={capturedAt,running:true,recorderVersion:'0.3.0',scopePrefixes:['LFE','LFF'],accountsSeen:['LFE-TEST']};
 assert.equal(accountAvailability(account,monitor,now+15000),'connected');assert.equal(accountAvailability(account,monitor,now+90001),'last-known');assert.equal(monitorFresh({...monitor,running:false},now),false);
 assert.equal(accountAvailability(account,{...monitor,running:false},now),'last-known');assert.equal(accountAvailability(account,{...monitor,accountsSeen:[]},now),'not-seen');assert.equal(accountAvailability({...account,connected:false},monitor,now),'disconnected');
 assert.equal(monitorFresh({...monitor,capturedAt:'2026-10-16T22:00:00Z'},now),false);
});
test('browser permission takes precedence over a previous stopped snapshot and permission errors',()=>{
 const monitor:AccountMonitor={capturedAt,running:false,recorderVersion:'0.3.0',scopePrefixes:['LFE'],accountsSeen:['LFE-TEST']};
 const monday=Date.parse('2026-10-19T14:02:00Z'),state={phase:'permission' as const,syncEnabled:true,syncing:false,hasError:false,monitor};
 assert.equal(accountSyncStatus(state,monday),'permission');
 assert.equal(accountSyncStatus({...state,hasError:true},monday),'permission');
 assert.equal(accountSyncStatus({...state,phase:'watching'},monday),'stale');
 assert.equal(accountSyncStatus({...state,phase:'disconnected'},monday),'disconnected');
 assert.equal(accountSyncStatus({...state,phase:'watching',syncEnabled:false},monday),'paused');
});
test('connection status preserves snapshot freshness rather than assuming a connected folder is live',()=>{
 const monitor:AccountMonitor={capturedAt,running:true,recorderVersion:'0.3.0',scopePrefixes:['LFE'],accountsSeen:['LFE-TEST']};
 const state={phase:'watching' as const,syncEnabled:true,syncing:false,hasError:false,monitor};
 assert.equal(accountSyncStatus(state,now+15000),'fresh');
 assert.equal(accountSyncStatus(state,now+90001),'stale');
 assert.equal(accountSyncStatus({...state,monitor:{...monitor,running:false}},now+15000),'stale');
 assert.equal(accountSyncStatus({...state,monitor:null},now),'waiting');
 assert.equal(accountSyncStatus({...state,hasError:true},now),'error');
 assert.equal(accountSyncStatus({...state,phase:'loading'},now),'loading');
});
test('simulators, out-of-scope accounts, malformed balances and future snapshots cannot enter the account monitor',()=>{
 for(const account of ['Sim101','Playback101','OTHER-ACCOUNT']){const raw=capture();raw.accounts[0].account=account;assert.throws(()=>validateAccountState(raw,now),/out-of-scope/);}
 for(const value of [NaN,Infinity,1e15]){const raw=capture();raw.accounts[0].values.CashValue.value=value;assert.throws(()=>validateAccountState(raw,now),/reported account value/);}
 const future=capture();future.capturedAt='2026-10-17T21:00:00Z';assert.throws(()=>validateAccountState(future,now),/clock/);
 const invalidDate=capture();invalidDate.capturedAt='2026-02-30T21:00:00Z';assert.throws(()=>validateAccountState(invalidDate,now),/capture time/);
 const duplicates=capture();duplicates.accounts.push({...duplicates.accounts[0]});assert.throws(()=>validateAccountState(duplicates,now),/duplicate/);
 const disconnected=capture();disconnected.accounts[0].connected=false;assert.throws(()=>validateAccountState(disconnected,now),/Disconnected/);
});
test('open positions cover instruments outside the execution filters and reject impossible side or size',()=>{
 const raw:any=capture();raw.accounts[0].positions=[{instrument:'GC 12-26',side:'Short',quantity:2,averagePrice:4300.25}];
 assert.deepEqual(validateAccountState(raw,now).accounts[0].positions,raw.accounts[0].positions);
 raw.accounts[0].positions[0].quantity=-2;assert.throws(()=>validateAccountState(raw,now),/quantity/);raw.accounts[0].positions[0].quantity=2;
 raw.accounts[0].positions[0].side='Flat';assert.throws(()=>validateAccountState(raw,now),/side/);
});
