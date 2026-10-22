import {test} from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AccountProfile,Journal} from '../lib/types';
import type {AccountState,AccountStateData} from '../lib/account-state';

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
(Module as any)._load=originalLoad;
const profiles=new Map<string,AccountProfile>([failed,healthy,funded].map(account=>[account,{account,label:account===failed?'Failed eval label':account===healthy?'Healthy eval label':'Funded label',stage:account===funded?'Funded':'Evaluation',status:'Active',notes:''}]));
const journal:Journal={ready:true,trades:[],accounts:[],profiles:[...profiles.values()],notes:[],cash:[],imports:[],lastSaved:at,seedVersion:'synthetic',evaluationFailures:[{account:failed,at,balance:47999,floor:48000,source:'cash'}]};

test('current cards and summary balances exclude an automatic failed eval while healthy evals and funded accounts stay visible',()=>{
 const before=JSON.stringify({journal,accountState}),html=renderToStaticMarkup(createElement(CurrentAccountsView,{journal,profiles,onAccount:()=>{},onSetup:()=>{},onHistory:()=>{}}));
 assert.doesNotMatch(html,/Failed eval label|47,999/);assert.match(html,/Healthy eval label/);assert.match(html,/Funded label/);assert.match(html,/102,000/);assert.match(html,/2 of 2 accounts/);assert.match(html,/Include archived labels/);
 assert.equal(JSON.stringify({journal,accountState}),before);
});
