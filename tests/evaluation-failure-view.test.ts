import {test} from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AccountProfile,CashRecord,Journal} from '../lib/types';
import type {AccountState,AccountStateData} from '../lib/account-state';
import type {BalanceAdjustment} from '../lib/balance-adjustments';

const at='2026-10-22T20:00:00.000Z',failed='LFE05000000000101',healthy='LFE05000000000102',funded='LFF05000000000103';
const state=(account:string,cash:number):AccountState=>({account,capturedAt:at,currency:'USD',connected:true,connection:'Synthetic',provider:'Synthetic',values:{CashValue:{value:cash,at,source:'PlatformRead'}},positions:[],positionsAvailable:true,positionsAt:at});
const accountState:AccountStateData={monitor:{capturedAt:at,running:true,recorderVersion:'0.5.0',scopePrefixes:['LFE','LFF'],accountsSeen:[failed,healthy,funded]},accounts:[state(failed,47999),state(healthy,50000),state(funded,52000)]};
const originalLoad=(Module as any)._load;
(Module as any)._load=function(name:string,...rest:any[]){
 if(name.endsWith('.css'))return {};
 if(name==='./recorder-connection')return {useRecorder:()=>({phase:'ready',syncEnabled:true,syncing:false,error:'',syncError:'',accountStateError:'',accountStateLoading:false,accountState,busy:false})};
 return originalLoad.call(this,name,...rest);
};
const {CurrentAccountsView}=require('../app/current-accounts')as typeof import('../app/current-accounts');
const {AccountProgress}=require('../app/account-progress')as typeof import('../app/account-progress');
(Module as any)._load=originalLoad;
const profiles=new Map<string,AccountProfile>([failed,healthy,funded].map(account=>[account,{account,label:account===failed?'Failed eval label':account===healthy?'Healthy eval label':'Funded label',stage:account===funded?'Funded':'Evaluation',status:'Active',notes:''}]));
const journal:Journal={ready:true,trades:[],accounts:[],profiles:[...profiles.values()],notes:[],cash:[],imports:[],lastSaved:at,seedVersion:'synthetic',evaluationFailures:[{account:failed,at,balance:47999,floor:48000,source:'cash'}]};

test('current cards and summary balances exclude an automatic failed eval while healthy evals and funded accounts stay visible',()=>{
 const before=JSON.stringify({journal,accountState}),html=renderToStaticMarkup(createElement(CurrentAccountsView,{journal,profiles,onAccount:()=>{},onSetup:()=>{},onHistory:()=>{}}));
 assert.doesNotMatch(html,/Failed eval label|47,999/);assert.match(html,/Healthy eval label/);assert.match(html,/Funded label/);assert.match(html,/102,000/);assert.match(html,/2 of 2 accounts/);assert.match(html,/Include archived labels/);
 assert.equal(JSON.stringify({journal,accountState}),before);
});

test('annual Accounts payouts retain disconnected history, deduplicate deductions and exclude other years',()=>{
 const archived='LFF05000000000104',cash=(id:string,account:string,date:string,deduction:number):CashRecord=>({id,account,date,deduction,kind:'payout',received:null,expense:null,note:''});
 const adjustment=(patch:Partial<BalanceAdjustment>):BalanceAdjustment=>({id:'detected',account:archived,date:'2026-12-31',from:'2026-12-30T22:00:00Z',to:'2026-12-31T22:00:00Z',before:54000,after:53000,tradingNet:0,amount:-1000,kind:'payout',settled:true,source:'automatic-estimate',possiblePayoutIds:[],reasons:[],note:'',...patch});
 const source:Journal={...journal,cash:[cash('current',funded,'2026-10-20',2000),cash('historical',archived,'2026-01-01',3500),cash('previous-year',archived,'2025-12-31',8000),cash('next-year',archived,'2027-01-01',9000)],adjustments:[adjustment({}),adjustment({id:'matched',account:funded,date:'2026-10-20',amount:-2000,payoutId:'current'}),adjustment({id:'prior',date:'2025-12-31'}),adjustment({id:'future',date:'2027-01-01'})]};
 const before=JSON.stringify(source),html=renderToStaticMarkup(createElement(CurrentAccountsView,{journal:source,profiles,onAccount:()=>{},onSetup:()=>{},onHistory:()=>{}}));
 assert.match(html,/Payouts · 2026/);assert.match(html,/\$6,500\.00/);assert.match(html,/3 payouts · all accounts/);
 assert.doesNotMatch(html,/Open contracts|Last reported open contracts|accounts supplied positions/);
 assert.match(html,/Payouts · 2026<\/span><b>\$2,000\.00<\/b>/);
 assert.equal(JSON.stringify(source),before);
});

test('current cards and account review omit stale merged P&L and positions while keeping fresh balances',()=>{
 const original=accountState.accounts,old='2026-10-21T20:00:00.000Z';
 try{
  accountState.accounts=[{...state(funded,52000),values:{CashValue:{value:52000,at,source:'PlatformRead'},RealizedProfitLoss:{value:933.25,at:old,source:'PlatformRead'}},positionsAvailable:true,positionsAt:old,positions:[{instrument:'MNQ 12-26',side:'Long',quantity:2,averagePrice:29000}]}];
  for(const html of [renderToStaticMarkup(createElement(CurrentAccountsView,{journal,profiles,onAccount:()=>{},onSetup:()=>{},onHistory:()=>{}})),renderToStaticMarkup(createElement(AccountProgress,{account:funded,journal,onSaveFirm:async()=>true,busy:false}))]){
   assert.match(html,/\$52,000\.00/);assert.doesNotMatch(html,/933\.25|MNQ 12-26|Long 2/);
  }
  let html=renderToStaticMarkup(createElement(CurrentAccountsView,{journal,profiles,onAccount:()=>{},onSetup:()=>{},onHistory:()=>{}}));assert.match(html,/Not supplied in this snapshot/);
  accountState.accounts[0]={...accountState.accounts[0],values:{CashValue:{value:52000,at,source:'PlatformRead'},RealizedProfitLoss:{value:0,at,source:'PlatformRead'}}};
  html=renderToStaticMarkup(createElement(CurrentAccountsView,{journal,profiles,onAccount:()=>{},onSetup:()=>{},onHistory:()=>{}}));assert.match(html,/Realized P&amp;L · reported<\/span><strong[^>]*>\$0\.00<\/strong>/);assert.doesNotMatch(html,/933\.25/);
 }finally{accountState.accounts=original;}
});
