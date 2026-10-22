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
 assert.match(html,/Since payout/);assert.match(html,/5 more qualifying days/);assert.match(html,/Cycle reset after payout/);assert.match(html,/Oct 22/);assert.match(html,/observed deduction/);
 assert.doesNotMatch(html,/Cycle check needed|Confirm Lucid|save a new|reference!/);assert.equal(JSON.stringify(journal),before);
});
test('missing post-payout fees explain unavailable days instead of prompting a manual cycle reset',()=>{
 const journal=data();journal.realizedCheckpoints=[{account,capturedAt:cut,session:'2026-10-22',net:200,afterNet:null}];
 const html=render(journal);assert.match(html,/History incomplete/);assert.match(html,/Day count unavailable/);assert.match(html,/Commission data is incomplete/);assert.doesNotMatch(html,/Cycle check needed|Confirm Lucid|save a new/);
});
