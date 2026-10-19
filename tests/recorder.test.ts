import {test} from 'node:test';
import assert from 'node:assert/strict';
import {aggregateBars,executionMarkers,isRecorderFile,markerCoverage,newestPriceBar,validateCapture} from '../lib/recorder';
import type {CaptureRows,PriceBar} from '../lib/recorder';
import type {Fill,Trade} from '../lib/types';
import {buildSimulatorHistory} from '../lib/simulator';
import {needsCaptureRead} from '../lib/recorder-browser';
import type {RecorderFileInfo} from '../lib/recorder-browser';

const rows=():CaptureRows=>({
  root:{schemaVersion:'1',recorderVersion:'0.1.1',mode:'Sim101Only',day:'2026-10-16',dayTimeZone:'America/Chicago',savedAtUtc:'2026-10-16T18:27:33.5076202Z',warningCountThisRun:'0'},
  bars:[{Instrument:'MNQ 12-26',IntervalSeconds:'60',TimestampConvention:'end-of-bar',BarEndUtc:'2026-10-16T13:41:00.0000000Z',Open:'30200',High:'30210.25',Low:'30195',Close:'30205',Volume:'120',TradingHours:'Default 24 x 7',MergePolicy:'DoNotMerge'}],
  executions:[{Account:'Sim101',ID:'sim-entry',Instrument:'MNQ 12-26',Action:'Buy',Quantity:'1',Price:'30200',Time:'2026-10-16T13:40:01.0000000Z',Sequence:'1',RawAccountPosition:'1'}],issueCount:0,
});
test('recorder context normalizes the exact expiry, shifts end-of-bar to its minute, and separates simulator executions',()=>{
  const capture=validateCapture(rows(),'2026-10-16.tradebook.xml');
  assert.equal(capture.bars[0].contract,'MNQ 2026-12');
  assert.equal(new Date(capture.bars[0].start).toISOString(),'2026-10-16T13:40:00.000Z');
  assert.equal(capture.bars[0].end-capture.bars[0].start,60000);
  assert.equal(capture.simulatorFills,1);assert.ok(!('fills' in capture));assert.ok(!('executions' in capture));
  assert.equal(capture.simulation[0].id,'sim-entry');assert.equal(capture.simulation[0].price,30200);
  assert.ok(isRecorderFile('2026-10-16.tradebook.xml'));
  for(const name of ['2026-10-16.tradebook.xml.previous','2026-10-16.tradebook.xml.writing','2026-10-16.executions.csv','other.xml'])assert.ok(!isRecorderFile(name));
});
test('unknown account scopes, wrong sessions, malformed dates and inconsistent/unfinished candles fail closed',()=>{
  let input=rows();input.root.mode='AllAccounts';assert.throws(()=>validateCapture(input),/Unknown capture/);
  input=rows();input.executions[0].Account='REAL-ACCOUNT';assert.throws(()=>validateCapture(input),/unexpected account/);
  input=rows();input.bars[0].MergePolicy='MergeBackAdjusted';assert.throws(()=>validateCapture(input),/merge policy/);
  input=rows();input.bars[0].TradingHours='CME US Index Futures RTH';assert.throws(()=>validateCapture(input),/session/);
  input=rows();input.bars[0].High='30200';assert.throws(()=>validateCapture(input),/inconsistent/);
  input=rows();input.bars[0].Open='';assert.throws(()=>validateCapture(input),/Invalid open/);
  input=rows();input.bars[0].BarEndUtc='2026-10-16T18:28:00Z';assert.throws(()=>validateCapture(input),/unfinished/);
  input=rows();input.bars[0].BarEndUtc='2026-10-16T13:40:01Z';assert.throws(()=>validateCapture(input),/aligned/);
  input=rows();input.bars[0].BarEndUtc='2026-10-16T13:41:00';assert.throws(()=>validateCapture(input),/UTC/);
  input=rows();input.root.day='2026-02-30';assert.throws(()=>validateCapture(input),/date/);
  assert.throws(()=>validateCapture(rows(),'2026-10-15.tradebook.xml'),/date differ/);
  input=rows();input.bars.push({...input.bars[0]});assert.throws(()=>validateCapture(input),/Duplicate/);
  input=rows();delete input.executions[0].RawAccountPosition;assert.throws(()=>validateCapture(input),/reported simulator position/);
  input=rows();input.executions.push({...input.executions[0]});assert.throws(()=>validateCapture(input),/execution ID/);
  input=rows();input.executions[0].Action='Unknown';assert.throws(()=>validateCapture(input),/action/);
  input=rows();input.executions[0].Quantity='0';assert.throws(()=>validateCapture(input),/quantity/);
});
test('out-of-order candle records sort chronologically and an older snapshot cannot overwrite a newer observation',()=>{
  const input=rows();input.bars.unshift({...input.bars[0],BarEndUtc:'2026-10-16T13:45:00Z',Close:'30208'});
  const capture=validateCapture(input);assert.ok(capture.bars[0].end<capture.bars[1].end);
  const original=capture.bars[0],newer={...original,high:30215,capturedAt:original.capturedAt+15000};
  const map=new Map<string,PriceBar>();
  for(const bar of [original,newer,original,newer])map.set(bar.id,newestPriceBar(map.get(bar.id),bar));
  assert.equal(map.size,1);assert.equal(map.get(original.id)?.high,30215);
  input.issueCount=2;input.root.warningCountThisRun='1';assert.equal(validateCapture(input).warnings,2);
});
test('5m and 15m bars use observed OHLC, conserve volume, and never bridge contracts or invent missing buckets',()=>{
  const a=validateCapture(rows()).bars[0];
  const input=[{...a,start:a.start+60000,end:a.end+60000,open:30205,close:30209,high:30212,low:30204,volume:80},a,{...a,contract:'NQ 2026-12',open:30201,close:30202,volume:7},{...a,start:a.start+20*60000,end:a.end+20*60000,volume:3}];
  const output=aggregateBars(input,5),mnq=output.filter(b=>b.contract==='MNQ 2026-12');
  assert.equal(output.length,3);assert.equal(mnq[0].open,30200);assert.equal(mnq[0].close,30209);assert.equal(mnq[0].high,30212);assert.equal(mnq[0].low,30195);assert.equal(mnq[0].volume,200);
  assert.equal(mnq[1].start-mnq[0].start,20*60000);
  assert.equal(output.reduce((s,b)=>s+b.volume,0),210);
  assert.equal(aggregateBars(input,15).filter(b=>b.contract==='MNQ 2026-12').length,2);
});
const trade:Trade={id:'trade',account:'REAL-ACCOUNT',contract:'MNQ 2026-12',symbol:'MNQ',dir:'Long',entry:'2026-10-16T13:40:01Z',exit:'2026-10-16T13:40:35Z',qty:4,maxQty:4,avgEntry:30200,avgExit:30205,pnl:40,exitOrder:2,parts:[['entry',4,30200,'Buy'],['exit-1',1,30205,'Sell'],['exit-2',3,30205.25,'Sell']]};
const fill=(id:string,time:string,qty=4):Fill=>({id,contract:trade.contract,symbol:'MNQ',pv:2,time,ordinal:1,side:id==='entry'?'Buy':'Sell',qty,price:id==='entry'?30200:30205,pos:null});
test('each allocated partial exit gets its own actual time, price and size instead of an average-price marker',()=>{
  const fills=[fill('entry','2026-10-16T13:40:01.001Z'),fill('exit-1','2026-10-16T13:40:35.050Z',1),fill('exit-2','2026-10-16T13:40:35.099Z',3)];
  const marks=executionMarkers(trade,fills);
  assert.deepEqual(marks.map(m=>m.qty),[4,1,3]);assert.deepEqual(marks.map(m=>m.price),[30200,30205,30205.25]);
  assert.deepEqual(marks.map(m=>m.role),['Entry','Exit','Exit']);assert.equal(marks[2].time-marks[1].time,49);
  const bar=validateCapture(rows()).bars[0];assert.deepEqual(markerCoverage(marks,[bar]),{total:3,covered:3,missing:0,outside:0});
  assert.equal(executionMarkers(trade,fills.slice(1)).length,2);
  assert.equal(executionMarkers({...trade,dir:'Short'},fills)[0].role,'Exit');
});
test('coverage uses start-inclusive/end-exclusive minutes and exposes both missing and out-of-range prices',()=>{
  const a=validateCapture(rows()).bars[0],base={id:'a',side:'Buy' as const,role:'Entry' as const,qty:1};
  const marks=[{...base,time:a.start,price:a.open},{...base,id:'outside',time:a.start+1000,price:a.high+1},{...base,id:'end',time:a.end,price:a.close}];
  assert.deepEqual(markerCoverage(marks,[a]),{total:3,covered:2,missing:1,outside:1});
  assert.deepEqual(markerCoverage(marks,[]),{total:3,covered:0,missing:3,outside:0});
});

function simulatedShort(){
  const input=rows(),base=input.executions[0];
  input.executions=[
    {...base,ID:'cover-2',Action:'BuyToCover',Price:'30180',Time:'2026-10-16T13:40:35.0990000Z',Sequence:'3',RawAccountPosition:'0'},
    {...base,ID:'short',Action:'SellShort',Quantity:'2',Time:'2026-10-16T13:40:01.0010000Z',Sequence:'1',RawAccountPosition:'-2'},
    {...base,ID:'cover-1',Action:'BuyToCover',Price:'30190',Time:'2026-10-16T13:40:35.0500000Z',Sequence:'2',RawAccountPosition:'-1'},
  ];return validateCapture(input);
}
test('Sim101 review reconstructs partial fills from unordered XML records and repeated snapshots do not duplicate trades',async()=>{
  const capture=simulatedShort(),snapshot={name:'2026-10-16.tradebook.xml',savedAt:capture.savedAt,fills:capture.simulation};
  const history=await buildSimulatorHistory([snapshot,{...snapshot,name:'duplicate'}]);
  assert.equal(history.account,'Sim101');assert.equal(history.fills.length,3);assert.equal(history.trades.length,1);assert.equal(history.issues.length,0);
  assert.equal(history.trades[0].dir,'Short');assert.equal(history.trades[0].pnl,60);
  assert.deepEqual(history.trades[0].parts?.map(p=>p[1]),[2,1,1]);
  const repeat=await buildSimulatorHistory([snapshot]);assert.equal(repeat.trades[0].id,history.trades[0].id);
});
test('a later recorder snapshot completes an open Sim101 trade, and conflicting executions cannot produce test statistics',async()=>{
  const capture=simulatedShort(),snapshot={name:'2026-10-16.tradebook.xml',savedAt:capture.savedAt,fills:capture.simulation.slice(0,2)};
  const open=await buildSimulatorHistory([snapshot]);assert.equal(open.trades.length,0);assert.equal(open.issues.length,1);assert.equal(open.issues[0].remaining,-1);
  const closed=await buildSimulatorHistory([{...snapshot,fills:capture.simulation,savedAt:snapshot.savedAt+15000}]);assert.equal(closed.trades.length,1);assert.equal(closed.issues.length,0);assert.equal(closed.trades[0].pnl,60);
  await assert.rejects(()=>buildSimulatorHistory([snapshot,{...snapshot,name:'conflict',fills:[{...snapshot.fills[0],price:30201}]}]),/Conflicting Sim101 execution/);
});
test('already-connected price-only caches re-read unchanged files once to populate the new simulator view',()=>{
  const file={name:'2026-10-16.tradebook.xml',size:639815,lastModified:1000};
  const previous:RecorderFileInfo={...file,day:'2026-10-16',savedAt:1000,version:'0.1.1',contracts:['MNQ 2026-12'],barCount:1614,simulatorFills:11,warnings:0};
  assert.equal(needsCaptureRead(file,previous),true);
  assert.equal(needsCaptureRead(file,{...previous,simulationVersion:1}),true);
  const current={...previous,simulationVersion:1,captureVersion:2};assert.equal(needsCaptureRead(file,current),false);
  assert.equal(needsCaptureRead({...file,lastModified:2000},current),true);
  assert.equal(needsCaptureRead({...file,size:file.size+1},current),true);
});


test('light-mode 0.4 captures use the existing fill identity and accept execution-only days while retaining legacy bars',()=>{
 const input=rows();input.root.recorderVersion='0.4.0';input.root.mode='AccountsReadOnly';input.executions[0].Account='LFE-LIGHT';input.bars=[];
 const light=validateCapture(input,'2026-10-16.accounts.tradebook.xml');assert.equal(light.version,'0.4.0');assert.equal(light.accountFills.length,1);assert.equal(light.accountFills[0].id,'sim-entry');assert.equal(light.accountFills[0].price,30200);assert.equal(light.bars.length,0);
 input.bars=rows().bars;const retained=validateCapture(input,'2026-10-16.accounts.tradebook.xml');assert.equal(retained.bars.length,1);assert.deepEqual(retained.accountFills,light.accountFills);
});
