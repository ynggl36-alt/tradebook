import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type {AccountHistory,Fill,Trade} from '../lib/types';
import {netTradePnl,netTradeSummary,tradeCommission} from '../lib/trading-costs';
import {validateFirmReference} from '../lib/firm-reference';
import {reconstruct} from '../lib/reconstruct';
const fixture=(overrides:Partial<Trade>={}):Trade=>({id:'test',account:'LFE-TEST',contract:'MNQ 2026-12',symbol:'MNQ',dir:'Long',entry:'2026-10-16T14:00:00Z',exit:'2026-10-16T14:01:00Z',qty:3,maxQty:2,avgEntry:100,avgExit:110,pnl:60,exitOrder:2,...overrides});
test('Lucid commissions charge both sides and total entered quantity, including trades that change from a gross win to a net loss',()=>{
 assert.equal(tradeCommission(fixture()),3);assert.equal(netTradePnl(fixture()),57);
 assert.equal(tradeCommission(fixture({symbol:'NQ',contract:'NQ 2026-12'})),10.5);
 assert.equal(netTradePnl(fixture({qty:1,pnl:.5})),-.5);
});
test('unsupported firms, instruments and dates retain unknown costs instead of inventing a full net result',()=>{
 for(const t of [fixture({account:'OTHER-TEST'}),fixture({account:'Sim101'}),fixture({symbol:'GC'}),fixture({entry:'2026-08-25T14:00:00Z'})])assert.equal(tradeCommission(t),null);
 const s=netTradeSummary([fixture(),fixture({account:'OTHER-TEST'})]);assert.equal(s.net,null);assert.equal(s.complete,false);assert.equal(s.known,1);assert.equal(s.unknown,1);
 assert.equal(netTradeSummary([]).net,null);
});
test('synthetic trades reconcile gross profit less scheduled commissions without mutation',()=>{
 const seed=JSON.parse(fs.readFileSync('tests/fixtures/synthetic-history.json','utf8')),history=JSON.parse(seed.accounts[2].data)as AccountHistory,original=JSON.stringify(history.trades);
 const result=netTradeSummary(history.trades);assert.equal(result.known,2);assert.equal(result.commissions,4);assert.equal(result.net,6);assert.equal(result.complete,true);assert.equal(JSON.stringify(history.trades),original);
});
test('partial fills and reversals allocate each contract side once across completed trades',async()=>{
 const fills:Fill[]=[{id:'a',contract:'NQ 2026-12',symbol:'NQ',pv:20,side:'Buy',qty:2,price:100,time:'2026-10-16T14:00:00Z',pos:2,ordinal:1},{id:'b',contract:'NQ 2026-12',symbol:'NQ',pv:20,side:'Sell',qty:3,price:110,time:'2026-10-16T14:01:00Z',pos:-1,ordinal:2},{id:'c',contract:'NQ 2026-12',symbol:'NQ',pv:20,side:'Buy',qty:1,price:105,time:'2026-10-16T14:02:00Z',pos:0,ordinal:3}];
 const history=await reconstruct('LFE-TEST',fills);assert.equal(history.trades.length,2);
 assert.equal(netTradeSummary(history.trades).commissions,fills.reduce((n,f)=>n+f.qty*1.75,0));
});
test('firm records preserve zero, negative profit and unavailable values, and reject invalid amounts, dates and simulator accounts',()=>{
 const raw={account:'LFE-TEST',firm:'Lucid',date:'2026-10-16',currency:'USD',balance:50000,totalProfit:0,sessionPnl:-100,minimumBalance:null,profitTarget:3000,daysTraded:3,source:'Provided dashboard screenshot'};
 const ref=validateFirmReference(raw);assert.equal(ref.totalProfit,0);assert.equal(ref.minimumBalance,null);assert.equal(ref.sessionPnl,-100);
 assert.throws(()=>validateFirmReference({...raw,daysTraded:1.5}));assert.throws(()=>validateFirmReference({...raw,date:'2026-02-30'}));assert.throws(()=>validateFirmReference({...raw,balance:Infinity}));assert.throws(()=>validateFirmReference({...raw,account:'Sim101'}));
});
