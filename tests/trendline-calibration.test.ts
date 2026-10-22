import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {PriceBar} from '../lib/recorder';
import type {TrendLine} from '../lib/trendlines';
import {completedRoleReversal,measureTrendEntry,prepareTrends,scanTrends,observePairReaction} from '../lib/trendlines';

const M=60000,start=Date.parse('2026-10-19T00:00:00Z'),contract='NQ 2026-12';
function bar(i:number,o=105,h=106,l=104,c=105):PriceBar{return {id:contract+'|'+(start+i*M),contract,start:start+i*M,end:start+(i+1)*M,open:o,high:h,low:l,close:c,volume:1,capturedAt:start+(i+1)*M+10000000};}
function five(rows:PriceBar[]){return rows.flatMap((b,i)=>Array.from({length:5},(_,j)=>bar(i*5+j,b.open,b.high,b.low,b.close)));}

test('1m supplies timing only; insufficient 5m/15m geometry is not a negative setup result',()=>{
 const prices=Array.from({length:120},(_,i)=>bar(i));
 const early=scanTrends(prepareTrends(prices,contract),start+20*M).snapshot;
 assert.equal(early.atr,2);assert.equal(early.status,'insufficient-prices');assert.ok(early.geometry!.every(g=>!g.available));
 const entry={account:'SYNTHETIC',id:'entry',contract,entry:new Date(start+20*M+1).toISOString(),entryPrice:105,gross:0,net:0};
 assert.equal(measureTrendEntry(entry,early).group,'unknown');
 const later=scanTrends(prepareTrends(prices,contract),start+120*M);
 assert.ok(later.snapshot.geometry!.find(g=>g.minutes===5)!.available);assert.equal(later.snapshot.geometry!.find(g=>g.minutes===15)!.available,false);
 assert.ok(later.pairs.every(p=>[5,15].includes(p.wick.minutes)));assert.ok(later.snapshot.lines.every(l=>[5,15].includes(l.minutes)));
});

test('a prominent wick does not certify a flat body, and missing prior ATR cannot certify prominence',()=>{
 const logical=Array.from({length:90},(_,i)=>bar(i));for(const i of [5,10,20,40])logical[i]=bar(i,105,106,100,105);
 const scan=scanTrends(prepareTrends(five(logical),contract),start+90*5*M);
 const pair=scan.pairs.find(p=>p.wick.minutes===5&&p.wick.a.time===start+20.5*5*M&&p.wick.b.time===start+40.5*5*M)!;
 assert.ok(pair);assert.equal(pair.wick.structureValid,true);assert.equal(pair.body.structureValid,false);
 assert.equal(pair.body.a.prominent,false);assert.equal(pair.wick.a.prominent,true);
 assert.ok(scan.pairs.every(p=>[p.wick.a,p.wick.b].every(a=>!a.prominent||a.time>=start+14*5*M)));
 const weak=Array.from({length:450},(_,i)=>bar(i,105+Math.sin(i/5)*.1,106+Math.sin(i/5)*.1,104+Math.sin(i/5)*.1,105+Math.sin(i/5)*.1));
 assert.equal(scanTrends(prepareTrends(weak,contract),start+450*M).snapshot.confirmed,0);
});

function flipFixture(){
 const logical=Array.from({length:14},(_,i)=>bar(i,98,99,97,98));
 logical[7]=bar(7,98,100,97,98);logical[8]=bar(8,97,98,96,97);logical[9]=bar(9,98,100,97,98);
 logical[10]=bar(10,97,98,96,97);logical[11]=bar(11,97,98,96,97);logical[12]=bar(12,98,100,97,98);
 const bars=prepareTrends(five(logical),contract).streams.find(s=>s.minutes===5)!.bars;
 const anchor={time:start,price:100,edge:'wick' as const,impulse:false,availableAt:start,prominent:true};
 const line:TrendLine={id:'synthetic-support',family:contract+'|synthetic',minutes:5,polarity:'support',style:'wick',a:anchor,b:{...anchor,time:start+10*M},availableAt:start+20*M,asOf:start+70*M,value:100,slope:0,touches:2,wickTouches:2,bodyTouches:0,broken:true,score:0,segmentStart:start,segmentEnd:start+70*M,structureValid:true};
 return {bars,line};
}

test('a role reversal needs a break, a later retest and a distinct completed close before entry',()=>{
 const {bars,line}=flipFixture(),before=JSON.stringify(line);
 assert.equal(completedRoleReversal(line,bars,6,7),null);
 const confirmed=completedRoleReversal(line,bars,6,8)!;assert.ok(confirmed);
 assert.equal(confirmed.polarity,'resistance');assert.equal(confirmed.availableAt,bars[8].end);
 assert.equal(confirmed.flip!.breakAt,bars[6].end);assert.equal(confirmed.flip!.retestAt,bars[7].start);
 assert.equal(confirmed.touches,0);assert.equal(JSON.stringify(line),before);
 const later=structuredClone(bars);later[10].close=1000;assert.deepEqual(completedRoleReversal(line,later,6,8),confirmed);
 const wrong=structuredClone(bars);wrong[7].close=103;wrong[7].high=104;assert.equal(completedRoleReversal(line,wrong,6,8),null);
 assert.equal(completedRoleReversal({...line,touches:0},bars,6,8),null);
 assert.equal(completedRoleReversal({...line,structureValid:false},bars,6,8),null);
});

test('flip formation and adjacent contacts remain one episode; a later separate test is independent',()=>{
 const {bars,line}=flipFixture();
 assert.equal(completedRoleReversal(line,bars,6,9)!.touches,0);
 assert.equal(completedRoleReversal(line,bars,6,12)!.touches,1);
 const wrong=structuredClone(bars);wrong[11].close=103;assert.equal(completedRoleReversal(line,wrong,6,12),null);
});

test('original body/wick replay pairs survive a later break instead of being filtered by role reversal',()=>{
 const logical=Array.from({length:110},(_,i)=>bar(i,104,105,103,104));
 for(const i of [20,40,55])logical[i]=bar(i,104,105,100,104);
 const early=scanTrends(prepareTrends(five(logical),contract),start+65*5*M);
 const pair=early.pairs.find(p=>p.wick.minutes===5&&p.wick.a.time===start+20.5*5*M&&p.wick.b.time===start+40.5*5*M)!;assert.ok(pair);
 logical[66]=bar(66,104,104,97,98);for(let i=67;i<110;i++)logical[i]=bar(i,98,99,97,98);
 logical[70]=bar(70,98,100,97,98);logical[71]=bar(71,97,98,96,97);
 const prepared=prepareTrends(five(logical),contract),late=scanTrends(prepared,start+90*5*M),same=late.pairs.find(p=>p.id===pair.id)!;
 assert.ok(same);assert.equal(same.wick.polarity,'support');assert.equal(same.wick.flip,undefined);
 assert.deepEqual(observePairReaction(prepared,same),observePairReaction(prepared,pair));
});

test('an impulse anchor retains its geometric availability when its pivot later confirms',()=>{
 const logical=Array.from({length:70},(_,i)=>bar(i,102,103,101,102));
 logical[20]=bar(20,102,110,101,102);logical[40]=bar(40,100,111,99,110);
 const prepared=prepareTrends(five(logical),contract),earlier=scanTrends(prepared,start+41*5*M),later=scanTrends(prepared,start+44*5*M);
 const pick=(scan:ReturnType<typeof scanTrends>)=>scan.pairs.find(p=>p.wick.minutes===5&&p.wick.a.time===start+20.5*5*M&&p.wick.b.time===start+40.5*5*M)!;
 const a=pick(earlier),b=pick(later);assert.ok(a&&b);assert.equal(a.wick.availableAt,start+41*5*M);assert.equal(b.wick.availableAt,a.wick.availableAt);
 assert.equal(a.wick.b.prominent,false);assert.equal(b.wick.b.prominent,true);
 assert.deepEqual(observePairReaction(prepared,a),observePairReaction(prepared,b));
});

test('impulse B continuation candles remain the anchor episode until a separated return',()=>{
 const logical=Array.from({length:70},(_,i)=>bar(i,102,103,101,102));
 logical[20]=bar(20,102,110,101,102);logical[40]=bar(40,100,110,99,109);
 logical[41]=bar(41,102,110,101,102);logical[42]=bar(42,102,110,101,102);
 const pick=(prices:PriceBar[])=>scanTrends(prepareTrends(five(prices),contract),start+70*5*M).pairs.find(p=>p.wick.minutes===5&&p.wick.a.time===start+20.5*5*M&&p.wick.b.time===start+40.5*5*M)!.wick;
 const continuation=pick(logical);assert.equal(continuation.structureBasis,'impulse-continuation');assert.equal(continuation.touches,0);
 logical[46]=bar(46,102,110,101,102);assert.equal(pick(logical).touches,1);
});
