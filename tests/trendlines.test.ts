import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {PriceBar} from '../lib/recorder';
import {inTrendPilot,measureTrendEntry,observePairReaction,prepareTrends,scanTrends,summarizeReactions,summarizeTrendEntries,trendValueAt,TREND_VERSION} from '../lib/trendlines';
import type {PairCheck,TrendEntry,TrendLine,TrendSnapshot} from '../lib/trendlines';
import {runTrendJob} from '../lib/trendline-runner';
const start=Date.parse('2026-10-19T12:00:00Z'),contract='NQ 2026-12';
function candle(i:number,open:number,high:number,low:number,close:number):PriceBar{return {id:contract+'|'+(start+i*60000),contract,start:start+i*60000,end:start+(i+1)*60000,open,high,low,close,volume:10,capturedAt:start+(i+1)*60000+10000000};}
function expandFive(prices:PriceBar[]){return prices.flatMap((b,i)=>Array.from({length:5},(_,j)=>candle(i*5+j,b.open,b.high,b.low,b.close)));}
function waves(n=240){return Array.from({length:n},(_,i)=>{const level=1000+i*.2+Math.sin(i*Math.PI/10)*4;return candle(i,level,level+1.5,level-1.5,level+.5);});}
const entry=(at=start+180*60000):TrendEntry=>({id:'synthetic-entry',account:'TEST',contract,entry:new Date(at+15000).toISOString(),entryPrice:1035,gross:100,net:95});

test('pre-entry geometry and labels cannot see entry-minute or later prices, outcomes, direction or reordered input',()=>{
  const prices=waves(),at=start+180*60000,base=scanTrends(prepareTrends(prices,contract),at);
  assert.equal(base.snapshot.status,'measured');assert.ok(base.snapshot.pairs>0);assert.ok(base.snapshot.lines.length>0);
  const later=prices.map(b=>b.start>=at?{...b,high:9000,low:1,open:5000,close:6000,capturedAt:b.capturedAt+1}:b).reverse();
  assert.deepEqual(scanTrends(prepareTrends(later,contract),at),base);
  const first=measureTrendEntry(entry(at),base.snapshot),changed=measureTrendEntry({...entry(at),gross:-90000,net:-91000},base.snapshot);
  assert.equal(first.group,changed.group);assert.deepEqual(first.lineIds,changed.lineIds);
  const truncated=scanTrends(prepareTrends(prices.filter(b=>b.end<=at),contract),at);
  assert.deepEqual(truncated,base);
  assert.ok(base.snapshot.lines.every(l=>l.availableAt<=at&&l.a.availableAt<=at&&l.b.availableAt<=at));
});

test('strict aggregates omit incomplete buckets and cannot bridge missing, malformed or foreign minutes',()=>{
  const prices=waves(90),prepared=prepareTrends(prices.filter((_,i)=>i!==32),contract);
  const five=prepared.streams.find(s=>s.minutes===5)!.bars;
  assert.equal(five.length,17);assert.equal(five.some(b=>b.start===start+30*60000),false);
  assert.notEqual(five.find(b=>b.start===start+25*60000)!.segment,five.find(b=>b.start===start+35*60000)!.segment);
  const foreign={...prices[32],contract:'MNQ 2026-12',id:'MNQ 2026-12|'+prices[32].start};
  const malformed={...prices[32],high:1};
  assert.deepEqual(prepareTrends([...prices.filter((_,i)=>i!==32),foreign,malformed],contract),prepared);
  assert.equal(scanTrends(prepared,start+40*60000).snapshot.status,'insufficient-prices');
  const after=scanTrends(prepared,start+90*60000).snapshot;
  assert.ok(after.lines.every(l=>l.a.time>=start+33*60000));
});

test('observations resolve deterministically by correction time and ties, independent of order',()=>{
  const prices=waves(50),correction={...prices[20],close:prices[20].close+.25,capturedAt:prices[20].capturedAt+1};
  const tied={...correction,high:correction.high+2};
  const a=prepareTrends([...prices,correction,tied],contract),b=prepareTrends([tied,...prices.reverse(),correction],contract);
  assert.deepEqual(a,b);assert.equal(a.minuteBars[20].high,tied.high);
});

test('impulse eligibility uses prior-only ATR and cannot label a flat doji as an impulse',()=>{
  const prices=Array.from({length:35},(_,i)=>candle(i,100,101,99,100));
  prices[20]=candle(20,100,111,99.5,110);
  const bars=prepareTrends(prices,contract).minuteBars;
  assert.equal(bars[13].atr,null);assert.equal(bars[20].atr,2);assert.equal(bars[20].impulse,true);assert.equal(bars[19].impulse,false);
  const changed=prices.slice(0,21);changed[20]=candle(20,100,150,99,149);
  assert.equal(prepareTrends(changed,contract).minuteBars[20].atr,2);
});

test('flat volatility uses a finite tick floor; missing first fill stays unknown',()=>{
  const prices=Array.from({length:100},(_,i)=>candle(i,100,100,100,100)),snapshot=scanTrends(prepareTrends(prices,contract),start+100*60000).snapshot;
  assert.equal(snapshot.atr,0);assert.equal(snapshot.tolerance,1);assert.ok(snapshot.lines.every(l=>Number.isFinite(l.value)));
  const row=measureTrendEntry({...entry(start+100*60000),entryPrice:null},snapshot);assert.equal(row.status,'missing-entry-fill');assert.equal(row.group,'unknown');
});

test('shared pairs receive WW/BB and mixed variants before bounded geometry-only style selection',()=>{
  const result=scanTrends(prepareTrends(waves(400),contract),start+400*60000);
  assert.equal(result.snapshot.variants,result.snapshot.pairs*4);assert.equal(result.pairs.length,result.snapshot.pairs);
  assert.ok(result.snapshot.truncated);assert.ok(result.snapshot.pairs<=3*2*160);
  for(const p of result.pairs){assert.equal(p.body.family,p.wick.family);assert.equal(p.body.a.time,p.wick.a.time);assert.equal(p.body.b.time,p.wick.b.time);assert.equal(p.body.availableAt,p.wick.availableAt);}
  assert.ok(result.snapshot.lines.every(l=>!l.broken));
});

test('two-anchor geometry is not an independent touch and coincident styles never double count trades',()=>{
  const result=scanTrends(prepareTrends(waves(200),contract),start+200*60000);
  const line=result.pairs.find(p=>!p.wick.broken&&p.wick.structureValid)?.wick;assert.ok(line);
  const base:TrendSnapshot={...result.snapshot,lines:[{...line,style:'wick',touches:0},{...line,id:line.id+'body',style:'body',touches:0}]};
  const e={...entry(),entryPrice:trendValueAt(line,Date.parse(entry().entry))};
  assert.equal(measureTrendEntry(e,base).group,'neither');assert.equal(measureTrendEntry(e,base).candidateNear,2);
  base.lines.forEach(l=>l.touches=1);const r=measureTrendEntry(e,base);assert.equal(r.group,'both');assert.equal(summarizeTrendEntries([r]).find(g=>g.group==='both')!.count,1);
  assert.equal(measureTrendEntry({...e,entryPrice:null},base).group,'unknown');
});

test('line interpolation matches wall-clock chart positions and exact fill seconds',()=>{
  const scanned=scanTrends(prepareTrends(waves(180),contract),start+180*60000).snapshot,line=scanned.lines.find(l=>l.slope!==0)!;assert.ok(line);
  assert.equal(trendValueAt(line,line.a.time),line.a.price);assert.ok(Math.abs(trendValueAt(line,line.b.time)-line.b.price)<1e-9);
  const at=(line.a.time+line.b.time)/2;assert.ok(Math.abs(trendValueAt(line,at)-(line.a.price+line.b.price)/2)<1e-9);
  const e={...entry(),entryPrice:trendValueAt(line,Date.parse(entry().entry))};
  assert.equal(measureTrendEntry(e,{...scanned,lines:[line]}).nearest,0);
});

test('forward price-reaction replay is separate, uses a complete same-segment fixed window and deduplicates families',()=>{
  const prepared=prepareTrends(waves(220),contract),scan=scanTrends(prepared,start+180*60000);
  const pair=scan.pairs.find(p=>p.wick.availableAt<start+190*60000)!;assert.ok(pair);
  const before=structuredClone(scan.snapshot),reaction=observePairReaction(prepared,pair);
  assert.deepEqual(scan.snapshot,before);assert.equal(summarizeReactions([reaction,reaction]).complete,Number(reaction.status==='complete'));
  assert.equal(observePairReaction(prepared,pair,pair.wick.availableAt+5*60000).status,'incomplete');
  const altered=prepareTrends(waves(220).filter(b=>b.start!==pair.wick.availableAt+3*pair.wick.minutes*60000),contract);
  assert.equal(observePairReaction(altered,pair).status,'incomplete');
});

test('pilot dates use Central entry date and leave the rest of the year outside the cohort',()=>{
  assert.equal(inTrendPilot('2026-10-07T04:59:59Z'),false);assert.equal(inTrendPilot('2026-10-07T05:00:00Z'),true);
  assert.equal(inTrendPilot('2026-10-21T04:59:59Z'),true);assert.equal(inTrendPilot('2026-10-21T05:00:00Z'),false);
});

test('runner reuses minute snapshots across accounts without retaining candidate objects or duplicating reaction observations',async()=>{
  const first=entry(),second={...first,id:'other',account:'OTHER',net:null};let progress=0;
  const result=await runTrendJob({id:'test',entries:[first,second],prices:waves(240)},n=>progress=n);
  assert.equal(result.snapshots,1);assert.equal(result.rows.length,2);assert.equal(progress,2);
  assert.equal(result.rows[0].group,result.rows[1].group);assert.equal(result.rows[1].net,null);assert.equal(result.rows[0].snapshot.version,TREND_VERSION);
  const totals=summarizeTrendEntries(result.rows).find(g=>g.count===2)!;assert.equal(totals.net,null);assert.equal(totals.unknownCosts,1);
});

test('finite but extreme OHLC cannot overflow into a measured infinite tolerance',()=>{
  const prices=Array.from({length:50},(_,i)=>candle(i,1e308,1.7e308,1,1e308));
  const result=scanTrends(prepareTrends(prices,contract),start+50*60000);
  assert.equal(result.snapshot.status,'insufficient-prices');assert.equal(result.snapshot.tolerance,null);assert.equal(result.snapshot.lines.length,0);
});

test('non-impulse swing anchors become eligible exactly after two later complete candles',()=>{
  const prices=Array.from({length:80},(_,i)=>{const level=1000+Math.cos(i*Math.PI/10)*20;return candle(i,level,level+1,level-1,level);});
  const at=start+53*5*60000,prepared=prepareTrends(expandFive(prices),contract),anchorTime=start+50.5*5*60000;
  const before=scanTrends(prepared,at-1),after=scanTrends(prepared,at);
  const has=(r:ReturnType<typeof scanTrends>)=>r.pairs.some(p=>p.wick.a.time===anchorTime||p.wick.b.time===anchorTime);
  assert.equal(has(before),false);assert.equal(has(after),true);
  const line=after.pairs.find(p=>p.wick.b.time===anchorTime)!.wick;assert.equal(line.availableAt,at);
});

test('adjacent contact bars form one episode and a pre-entry close breach stays broken',()=>{
  const prices=Array.from({length:110},(_,i)=>candle(i,101.5,102,100,101.5));
  // Distinct support pivots at 20 and 40. Later repeated contact bars should
  // remain the B anchor episode rather than supply independent confirmations.
  prices[20]=candle(20,101.5,102,99,101.5);prices[40]=candle(40,101.5,102,99,101.5);
  const prepared=prepareTrends(expandFive(prices),contract),scan=scanTrends(prepared,start+90*5*60000);
  const family=scan.pairs.find(p=>p.wick.minutes===5&&p.wick.polarity==='support'&&p.wick.a.time===start+20.5*5*60000&&p.wick.b.time===start+40.5*5*60000);
  assert.ok(family);assert.equal(family.wick.touches,0);
  for(const i of [60,61])prices[i]=candle(i,103,104,102,103);
  const returned=scanTrends(prepareTrends(expandFive(prices),contract),start+90*5*60000).pairs.find(p=>p.id===family.id)!;
  assert.equal(returned.wick.touches,1);
  prices[70]=candle(70,96,103,95,96);const broken=scanTrends(prepareTrends(expandFive(prices),contract),start+90*5*60000).pairs.find(p=>p.id===family.id);
  assert.ok(broken);assert.equal(broken.wick.broken,true);assert.equal(broken.body.broken,true);
});

function reactionFixture(mode:'body'|'wick'|'both'|'neither',resistance=false,contactIndex=31,lateBreach=false){
  const prices=Array.from({length:55},(_,i)=>candle(i,102,103,101,102));
  for(const i of [15,27])prices[i]=candle(i,100,103,97,102);
  for(let i=30;i<42;i++)prices[i]=candle(i,104,105,103,104);
  if(mode==='body'||mode==='both')prices[contactIndex]=candle(contactIndex,102,103,100,102);
  if(mode==='wick'||mode==='both')prices[mode==='both'?contactIndex+2:contactIndex]=candle(mode==='both'?contactIndex+2:contactIndex,102,103,97,102);
  if(lateBreach)prices[41]=candle(41,104,105,94,95);
  if(resistance)for(let i=0;i<prices.length;i++){const p=prices[i];prices[i]={...p,open:200-p.open,close:200-p.close,high:200-p.low,low:200-p.high};}
  const make=(edge:'wick'|'body'):TrendLine=>{
    const price=edge==='wick'?(resistance?103:97):100;
    return {id:edge,family:'reaction-fixture',minutes:1,polarity:resistance?'resistance':'support',style:edge,a:{time:start+15.5*60000,price,edge,impulse:false,availableAt:start+18*60000},b:{time:start+27.5*60000,price,edge,impulse:false,availableAt:start+30*60000},availableAt:start+30*60000,asOf:start+30*60000,value:price,slope:0,touches:0,wickTouches:0,bodyTouches:0,broken:false,score:0,segmentStart:start,segmentEnd:start+55*60000};
  };
  const pair:PairCheck={id:'reaction-fixture',impulse:false,wick:make('wick'),body:make('body'),bothEligible:true};
  return observePairReaction(prepareTrends(prices,contract),pair);
}

test('paired reaction protocol discriminates body-only, wick-only, both and neither for support and resistance',()=>{
  for(const resistance of [false,true])for(const mode of ['body','wick','both','neither'] as const){
    const result=reactionFixture(mode,resistance);assert.equal(result.status,'complete');
    assert.equal(result.body,mode==='body'||mode==='both',mode+' body / resistance='+resistance);
    assert.equal(result.wick,mode==='wick'||mode==='both',mode+' wick / resistance='+resistance);
  }
});

test('a last-three-candle contact or a late closing breach cannot earn a replay reaction',()=>{
  assert.equal(reactionFixture('body',false,39).body,false);
  const late=reactionFixture('both',false,31,true);assert.equal(late.body,false);assert.equal(late.wick,false);
});

test('entry ATR includes the final completed pre-entry candle while impulse ATR excludes its own candle',()=>{
  const prices=Array.from({length:50},(_,i)=>candle(i,100,101,99,100));prices[49]=candle(49,100,110,90,100);
  const prepared=prepareTrends(prices,contract),snapshot=scanTrends(prepared,start+50*60000).snapshot;
  assert.equal(prepared.minuteBars[49].atr,2);assert.equal(snapshot.atr,46/14);
});

test('only the higher-timeframe geometry cap marks a bounded search; 1m timing history stays complete',()=>{
  const prices=Array.from({length:4500},(_,i)=>candle(i,100,100,100,100)),scan=scanTrends(prepareTrends(prices,contract),start+4500*60000);
  assert.equal(scan.snapshot.minutesCovered,4500);assert.equal(scan.snapshot.geometry!.find(g=>g.minutes===5)!.bars,720);assert.equal(scan.snapshot.truncated,true);
  const shorter=scanTrends(prepareTrends(prices.slice(0,900),contract),start+900*60000);assert.equal(shorter.snapshot.truncated,false);
});
