import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {FlexProgress} from '../app/flex-progress';
import type {Journal} from '../lib/types';

const account='LFF05000000000021',cut='2026-10-22T06:00:00Z';
function data():Journal{return {ready:true,trades:[],accounts:[],profiles:[],notes:[],cash:[],imports:[],lastSaved:cut,seedVersion:'synthetic',realizedSessions:[],realizedCheckpoints:[],adjustments:[{id:'synthetic-payout',account,date:'2026-10-22',from:'2026-10-22T05:59:00Z',to:cut,before:54000,after:52000,tradingNet:0,amount:-2000,kind:'payout',settled:true,source:'automatic-estimate',possiblePayoutIds:[],reasons:[],note:''}]};}
const render=(journal:Journal)=>renderToStaticMarkup(createElement(FlexProgress,{account,journal,now:Date.parse('2026-10-22T15:00:00Z'),compact:true,expanded:true}));
test('funded cards show an automatic reset without needing any manual firm checkpoint',()=>{
 const journal=data(),before=JSON.stringify(journal),html=render(journal);
 assert.match(html,/1 payout/);assert.match(html,/5 more qualifying days/);assert.match(html,/Cycle reset after payout/);assert.match(html,/Oct 22/);assert.match(html,/observed deduction/);
 assert.doesNotMatch(html,/Cycle check needed|Confirm Lucid|save a new|reference!/);assert.equal(JSON.stringify(journal),before);
});
test('missing post-payout fees explain unavailable days instead of prompting a manual cycle reset',()=>{
 const journal=data();journal.realizedCheckpoints=[{account,capturedAt:cut,session:'2026-10-22',net:200,afterNet:null}];
 const html=render(journal);assert.match(html,/1 payout/);assert.match(html,/Commission data incomplete/);assert.match(html,/Commission data is incomplete/);assert.doesNotMatch(html,/Waiting for latest P&amp;L|Cycle check needed|Confirm Lucid|save a new/);
});

test('pending session data keeps earlier confirmed profit days visible in text and the progress steps',()=>{
 const journal=data();journal.adjustments=[];journal.realizedSessions=[{account,contract:'MNQ 2026-12',symbol:'MNQ',day:'2026-10-21',gross:201,commissions:1,net:200,exits:1,quantity:1,unmatched:0},{account,contract:'MNQ 2026-12',symbol:'MNQ',day:'2026-10-22',gross:0,commissions:1,net:null,exits:1,quantity:1,unmatched:1,coverageIssues:1}];
 const html=render(journal);assert.match(html,/1<small> confirmed \/ 5 days/);assert.equal((html.match(/class="filled"/g)||[]).length,1);assert.match(html,/Historical trading data incomplete/);assert.doesNotMatch(html,/Waiting for latest P&amp;L/);
});
test('trading inside an observed payout window explains timing uncertainty and retains confirmed later days',()=>{
 const journal=data();journal.adjustments![0].tradingActivity=true;journal.realizedCheckpoints=[{account,capturedAt:cut,session:'2026-10-22',net:500,afterNet:200}];
 const html=render(journal);assert.match(html,/1<small> confirmed \/ 5 days/);assert.match(html,/exact time is unknown/);assert.match(html,/1 payout/);assert.match(html,/Exact day count unavailable/);assert.doesNotMatch(html,/Waiting for latest P&amp;L|Sync pending|Confirm Lucid|save a new|Cycle check needed/);
});


test('every funded card uses the same payout-count label without screenshot provenance',()=>{
 const journal=data();journal.adjustments=[];
 let html=render(journal);assert.match(html,/0 payouts/);assert.doesNotMatch(html,/Lucid checkpoint|Updated from saved data|First payout cycle|Since payout/);
 journal.cash=[{id:'saved-payout',account,kind:'payout',date:'2026-10-21',deduction:2000,received:null,expense:null,note:''}];
 journal.adjustments=[{...data().adjustments![0],date:'2026-10-21',payoutId:'saved-payout'}];
 html=render(journal);assert.match(html,/1 payout</);assert.doesNotMatch(html,/2 payouts|Lucid checkpoint|Updated from saved data/);
 journal.adjustments.push({...data().adjustments![0],id:'second-payout'});html=render(journal);assert.match(html,/2 payouts/);
});
