import type {PriceBar} from './recorder';
import {centralDay} from './analytics';

// Fixed before inspecting trading outcomes. This version is deliberately a
// continuous-session pilot: missing minutes and market closures split geometry.
export const TREND_VERSION='trendline-pilot-v1';
export const TREND_START='2026-10-07',TREND_END='2026-10-20';
export const TREND_START_AT=Date.parse('2026-10-07T00:00:00-05:00');
export const TREND_END_AT=Date.parse('2026-10-21T00:00:00-05:00');
export const TREND_BATCH=40,TREND_MAX_ENTRIES=2000;
export const TREND_STYLES=['wick','body','mixed'] as const;
export type TrendStyle=typeof TREND_STYLES[number];
export type Edge='wick'|'body';
export type Polarity='support'|'resistance';
export type TrendCandle={start:number;end:number;open:number;high:number;low:number;close:number;segment:number;atr:number|null;impulse:boolean};
export type TrendStream={minutes:number;bars:TrendCandle[]};
export type PreparedTrends={contract:string;streams:TrendStream[];minuteBars:TrendCandle[]};
export type TrendAnchor={time:number;price:number;edge:Edge;impulse:boolean;availableAt:number};
export type TrendLine={id:string;family:string;minutes:number;polarity:Polarity;style:TrendStyle;a:TrendAnchor;b:TrendAnchor;availableAt:number;asOf:number;value:number;slope:number;touches:number;wickTouches:number;bodyTouches:number;broken:boolean;score:number;segmentStart:number;segmentEnd:number};
export type PairCheck={id:string;impulse:boolean;wick:TrendLine;body:TrendLine;bothEligible:boolean};
export type TrendSnapshot={version:string;contract:string;asOf:number;status:'measured'|'insufficient-prices';atr:number|null;tolerance:number|null;minutesCovered:number;segmentStart:number|null;anchors:number;pairs:number;variants:number;intact:number;confirmed:number;truncated:boolean;lines:TrendLine[]};
export type TrendEntry={id:string;account:string;contract:string;entry:string;entryPrice:number|null;gross:number;net:number|null};
export type TrendEntryResult=TrendEntry&{status:'measured'|'insufficient-prices'|'missing-entry-fill';group:'body-only'|'wick-only'|'both'|'neither'|'unknown';mixed:boolean;impulse:boolean;confirmedNear:number;candidateNear:number;nearest:number|null;lineIds:string[];snapshot:Omit<TrendSnapshot,'lines'>};
export type ReactionCheck={id:string;impulse:boolean;status:'complete'|'incomplete'|'baseline-ineligible';body:boolean;wick:boolean;end:number};
export type ReactionSummary={complete:number;incomplete:number;baselineIneligible:number;bodyOnly:number;wickOnly:number;both:number;neither:number;impulse:{complete:number;bodyOnly:number;wickOnly:number;both:number;neither:number}};
const MINUTE=60000,MAX_ANCHORS=28,MAX_PAIRS=160,RIGHT=2,LEFT=2;
const finite=(n:number)=>Number.isFinite(n)&&n>0;
const edgePrice=(b:TrendCandle,p:Polarity,e:Edge)=>e==='wick'?(p==='support'?b.low:b.high):(p==='support'?Math.min(b.open,b.close):Math.max(b.open,b.close));
const center=(b:TrendCandle)=>(b.start+b.end)/2;
export const trendValueAt=(line:Pick<TrendLine,'a'|'slope'>,time:number)=>line.a.price+line.slope*(time-line.a.time);
export function inTrendPilot(entry:string){const day=centralDay(entry);return day>=TREND_START&&day<=TREND_END;}

export function prepareTrends(input:PriceBar[],contract:string):PreparedTrends{
  const unique=new Map<number,PriceBar>();
  for(const b of input){
    if(b.contract!==contract||b.id!==contract+'|'+b.start||!Number.isSafeInteger(b.start)||b.start%MINUTE||b.end!==b.start+MINUTE||!Number.isSafeInteger(b.capturedAt)||b.capturedAt<b.end||![b.open,b.high,b.low,b.close].every(finite)||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close)||b.low>b.high)continue;
    const old=unique.get(b.start);
    // Stable even for tied observation timestamps from different sources.
    if(!old||b.capturedAt>old.capturedAt||(b.capturedAt===old.capturedAt&&JSON.stringify([b.open,b.high,b.low,b.close])>JSON.stringify([old.open,old.high,old.low,old.close])))unique.set(b.start,b);
  }
  const raw=[...unique.values()].sort((a,b)=>a.start-b.start);
  const streams=[1,5,15].map(minutes=>{
    const size=minutes*MINUTE,buckets=new Map<number,PriceBar[]>();
    for(const b of raw){const start=Math.floor(b.start/size)*size;const rows=buckets.get(start)||[];rows.push(b);buckets.set(start,rows);}
    const bars:TrendCandle[]=[];let segment=0;
    for(const [start,rows] of buckets){
      if(rows.length!==minutes||rows.some((b,i)=>b.start!==start+i*MINUTE))continue;
      const previous=bars.at(-1);if(!previous||previous.end!==start)segment++;
      bars.push({start,end:start+size,open:rows[0].open,high:Math.max(...rows.map(b=>b.high)),low:Math.min(...rows.map(b=>b.low)),close:rows.at(-1)!.close,segment,atr:null,impulse:false});
    }
    for(let i=14;i<bars.length;i++){
      const b=bars[i];if(bars[i-14].segment!==b.segment)continue;
      let sum=0;
      for(let j=i-14;j<i;j++){const p=bars[j-1];sum+=Math.max(bars[j].high-bars[j].low,p?.segment===b.segment?Math.abs(bars[j].high-p.close):0,p?.segment===b.segment?Math.abs(bars[j].low-p.close):0);}
      if(!Number.isFinite(sum))continue;
      b.atr=sum/14;
      const range=b.high-b.low,tr=Math.max(range,Math.abs(b.high-bars[i-1].close),Math.abs(b.low-bars[i-1].close));
      b.impulse=b.atr>0&&range>0&&Math.abs(b.close-b.open)/range>=.7&&tr>=1.5*b.atr;
    }
    return {minutes,bars};
  });
  return {contract,streams,minuteBars:streams[0].bars};
}
function upperBound(bars:TrendCandle[],end:number){let lo=0,hi=bars.length;while(lo<hi){const mid=(lo+hi)>>>1;if(bars[mid].end<=end)lo=mid+1;else hi=mid;}return lo;}
type Event={index:number;availableAt:number;impulse:boolean};
function anchorEvents(bars:TrendCandle[],first:number,last:number,polarity:Polarity):Event[]{
  const events:Event[]=[];
  for(let i=first;i<=last;i++){
    const b=bars[i];let pivot=false;
    if(i>=first+LEFT&&i+RIGHT<=last){
      for(const edge of ['wick','body'] as const){
        const p=edgePrice(b,polarity,edge);let yes=true;
        // The rightmost point of a plateau wins deterministically.
        for(let j=i-LEFT;j<=i+RIGHT;j++){
          if(j===i)continue;const q=edgePrice(bars[j],polarity,edge),better=polarity==='support'?p<q:p>q;
          if(!(better||(p===q&&j<i))){yes=false;break;}
        }
        if(yes){pivot=true;break;}
      }
    }
    if(b.impulse||pivot)events.push({index:i,availableAt:b.impulse?b.end:bars[i+RIGHT].end,impulse:b.impulse});
  }
  return events;
}
function tolerance(b:TrendCandle){return Math.max(1,.25*(b.atr??0));}
function contacts(b:TrendCandle,value:number,p:Polarity,tol:number){
  return {wick:Math.abs(edgePrice(b,p,'wick')-value)<=tol,body:Math.abs(edgePrice(b,p,'body')-value)<=tol};
}
function breached(b:TrendCandle,value:number,p:Polarity,tol:number){return p==='support'?b.close<value-tol:b.close>value+tol;}
function scoreLine(bars:TrendCandle[],minutes:number,polarity:Polarity,a:Event,b:Event,ae:Edge,be:Edge,last:number,asOf:number,contract:string):TrendLine{
  const ca=bars[a.index],cb=bars[b.index],availableAt=Math.max(a.availableAt,b.availableAt);
  const family=[contract,minutes,polarity,ca.start,cb.start].join('|');
  const line:TrendLine={id:family+'|'+ae+'-'+be,family,minutes,polarity,style:ae===be?ae:'mixed',a:{time:center(ca),price:edgePrice(ca,polarity,ae),edge:ae,impulse:a.impulse,availableAt:a.availableAt},b:{time:center(cb),price:edgePrice(cb,polarity,be),edge:be,impulse:b.impulse,availableAt:b.availableAt},availableAt,asOf,value:0,slope:0,touches:0,wickTouches:0,bodyTouches:0,broken:false,score:0,segmentStart:bars[a.index].start,segmentEnd:bars[last].end};
  line.slope=(line.b.price-line.a.price)/(line.b.time-line.a.time);line.value=trendValueAt(line,asOf);
  if(!Number.isFinite(line.slope)||!Number.isFinite(line.value)){line.broken=true;return line;}
  let lastTouch=-100,lastWick=-100,lastBody=-100;
  for(let i=a.index+1;i<=last;i++){
    if(i===b.index)continue;const candle=bars[i],value=trendValueAt(line,center(candle)),tol=tolerance(candle);
    if(!Number.isFinite(value)||breached(candle,value,polarity,tol)){line.broken=true;break;}
    // Anchor candles and their confirmation window cannot be a third touch.
    if(candle.start<availableAt)continue;
    const touch=contacts(candle,value,polarity,tol);
    if(touch.wick||touch.body){if(i-lastTouch>=3)line.touches++;lastTouch=i;}
    if(touch.wick){if(i-lastWick>=3)line.wickTouches++;lastWick=i;}
    if(touch.body){if(i-lastBody>=3)line.bodyTouches++;lastBody=i;}
  }
  // Pure pre-entry geometry. Entry price, trade direction and outcomes never
  // enter this score. A pair itself supplies zero independent confirmations.
  line.score=Math.min(line.touches,8)*4+Math.log2(1+b.index-a.index)+Math.max(0,1-(last-b.index)/Math.max(1,last-a.index));
  return line;
}
export function scanTrends(prepared:PreparedTrends,entryAt:number):{snapshot:TrendSnapshot;pairs:PairCheck[]}{
  const asOf=Math.floor(entryAt/MINUTE)*MINUTE;
  const snapshot:TrendSnapshot={version:TREND_VERSION,contract:prepared.contract,asOf,status:'insufficient-prices',atr:null,tolerance:null,minutesCovered:0,segmentStart:null,anchors:0,pairs:0,variants:0,intact:0,confirmed:0,truncated:false,lines:[]};
  const end=upperBound(prepared.minuteBars,asOf),recent=prepared.minuteBars.slice(Math.max(0,end-20),end);
  if(recent.length!==20||recent.at(-1)!.end!==asOf||recent[0].segment!==recent.at(-1)!.segment)return {snapshot,pairs:[]};
  const atrBars=recent.slice(-15);let totalRange=0;
  for(let i=1;i<atrBars.length;i++)totalRange+=Math.max(atrBars[i].high-atrBars[i].low,Math.abs(atrBars[i].high-atrBars[i-1].close),Math.abs(atrBars[i].low-atrBars[i-1].close));
  snapshot.atr=totalRange/14;if(!Number.isFinite(snapshot.atr)){snapshot.atr=null;return {snapshot,pairs:[]};}
  snapshot.status='measured';snapshot.tolerance=Math.max(1,.25*snapshot.atr);
  const all:TrendLine[]=[],checks:PairCheck[]=[];
  for(const stream of prepared.streams){
    const {bars,minutes}=stream,last=upperBound(bars,asOf)-1;if(last<0)continue;
    // Do not project from a session which has already closed, or from an
    // incomplete latest bucket caused by a missing minute.
    if(asOf-bars[last].end>=minutes*MINUTE)continue;
    let first=last;while(first>0&&bars[first-1].segment===bars[last].segment&&last-first+1<720)first--;
    if(first>0&&bars[first-1].segment===bars[last].segment)snapshot.truncated=true;
    if(minutes===1){snapshot.minutesCovered=last-first+1;snapshot.segmentStart=bars[first].start;}
    if(last-first<18)continue;
    for(const polarity of ['support','resistance'] as const){
      const found=anchorEvents(bars,first,last,polarity);
      snapshot.anchors+=found.length;if(found.length>MAX_ANCHORS)snapshot.truncated=true;
      // Keep recent anchors plus evenly spaced older anchors. The common
      // universe is capped before expanding any anchor style.
      const selected=found.length<=MAX_ANCHORS?found:[...found.filter((_,i)=>i<found.length-16&&i%Math.ceil((found.length-16)/12)===0).slice(-12),...found.slice(-16)];
      const families:{a:Event;b:Event}[]=[];
      for(let j=1;j<selected.length;j++)for(let i=0;i<j;i++)if(selected[j].index-selected[i].index>=4)families.push({a:selected[i],b:selected[j]});
      families.sort((x,y)=>y.b.index-x.b.index||(y.b.index-y.a.index)-(x.b.index-x.a.index)||x.a.index-y.a.index);
      if(families.length>MAX_PAIRS)snapshot.truncated=true;
      for(const {a,b} of families.slice(0,MAX_PAIRS)){
        const variants=(['wick','body'] as const).flatMap(ae=>(['wick','body'] as const).map(be=>scoreLine(bars,minutes,polarity,a,b,ae,be,last,asOf,prepared.contract)));
        all.push(...variants);snapshot.pairs++;
        const wick=variants[0],body=variants[3];
        checks.push({id:wick.family,impulse:a.impulse||b.impulse,wick,body,bothEligible:!wick.broken&&!body.broken});
      }
    }
  }
  snapshot.variants=all.length;snapshot.intact=all.filter(l=>!l.broken).length;snapshot.confirmed=all.filter(l=>!l.broken&&l.touches>0).length;
  // Select without entry proximity. Coincident styles retain their masks for
  // measurement, while the chart may collapse coincident paths for readability.
  for(const style of TREND_STYLES)snapshot.lines.push(...all.filter(l=>!l.broken&&l.style===style).sort((a,b)=>Number(b.touches>0)-Number(a.touches>0)||b.score-a.score||a.id.localeCompare(b.id)).slice(0,2));
  return {snapshot,pairs:checks};
}
export function measureTrendEntry(entry:TrendEntry,snapshot:TrendSnapshot):TrendEntryResult{
  const {lines,...metadata}=snapshot;
  const row:TrendEntryResult={...entry,status:entry.entryPrice===null?'missing-entry-fill':snapshot.status,group:'unknown',mixed:false,impulse:false,confirmedNear:0,candidateNear:0,nearest:null,lineIds:[],snapshot:metadata};
  if(row.status!=='measured'||entry.entryPrice===null)return row;
  const candidates=lines.filter(l=>Math.abs(trendValueAt(l,Date.parse(entry.entry))-entry.entryPrice!)<=snapshot.tolerance!),near=candidates.filter(l=>l.touches>0);
  const body=near.some(l=>l.style==='body'),wick=near.some(l=>l.style==='wick');
  row.group=body?(wick?'both':'body-only'):(wick?'wick-only':'neither');row.mixed=near.some(l=>l.style==='mixed');row.impulse=near.some(l=>l.a.impulse||l.b.impulse);
  row.confirmedNear=near.length;row.candidateNear=candidates.length;row.lineIds=near.map(l=>l.id);
  row.nearest=lines.length?Math.min(...lines.map(l=>Math.abs(trendValueAt(l,Date.parse(entry.entry))-entry.entryPrice!))):null;
  return row;
}

// A separate, fixed 12-candle forward observation for matched WW/BB families.
// It cannot upgrade the pre-entry snapshot, score or entry classification.
// Both variants must first survive their common formation window; each then
// needs an independent contact, no closing breach, and a >=0.5 ATR move away
// within the next three candles. This is a price reaction, not a trade win.
export function observePairReaction(prepared:PreparedTrends,pair:PairCheck,endAt=TREND_END_AT):ReactionCheck{
  const wick=pair.wick,body=pair.body,stream=prepared.streams.find(s=>s.minutes===wick.minutes)!;
  const bars=stream.bars,start=upperBound(bars,wick.availableAt),window=bars.slice(start,start+12);
  const result:ReactionCheck={id:pair.id,impulse:pair.impulse,status:'incomplete',body:false,wick:false,end:window.at(-1)?.end??0};
  if(wick.availableAt<TREND_START_AT||wick.availableAt>=endAt||window.length!==12||window[0].start!==wick.availableAt||window.at(-1)!.end>endAt||window[0].segment!==window.at(-1)!.segment)return result;
  const a=bars.findIndex(b=>center(b)===wick.a.time),formationEnd=start-1;
  if(a<0)return result;
  const formed=(line:TrendLine)=>{for(let i=a+1;i<=formationEnd;i++)if(center(bars[i])!==line.b.time&&breached(bars[i],trendValueAt(line,center(bars[i])),line.polarity,tolerance(bars[i])))return false;return true;};
  if(!formed(wick)||!formed(body)){result.status='baseline-ineligible';return result;}
  result.status='complete';
  const reaction=(line:TrendLine)=>{
    if(window.some(b=>breached(b,trendValueAt(line,center(b)),line.polarity,tolerance(b))))return false;
    for(let i=0;i<9;i++){
      const b=window[i],hit=contacts(b,trendValueAt(line,center(b)),line.polarity,tolerance(b));if(!hit.wick&&!hit.body)continue;
      const distance=Math.max(1,.5*(b.atr??0));
      if(window.slice(i+1,i+4).some(next=>line.polarity==='support'?next.close-trendValueAt(line,center(next))>=distance:trendValueAt(line,center(next))-next.close>=distance))return true;
    }
    return false;
  };
  result.body=reaction(body);result.wick=reaction(wick);return result;
}
export function summarizeReactions(rows:ReactionCheck[]):ReactionSummary{
  const result:ReactionSummary={complete:0,incomplete:0,baselineIneligible:0,bodyOnly:0,wickOnly:0,both:0,neither:0,impulse:{complete:0,bodyOnly:0,wickOnly:0,both:0,neither:0}};
  for(const r of new Map(rows.map(r=>[r.id,r])).values()){
    if(r.status==='incomplete'){result.incomplete++;continue;}if(r.status==='baseline-ineligible'){result.baselineIneligible++;continue;}
    const group=r.body?(r.wick?'both':'bodyOnly'):(r.wick?'wickOnly':'neither');result.complete++;result[group]++;
    if(r.impulse){result.impulse.complete++;result.impulse[group]++;}
  }
  return result;
}
export function summarizeTrendEntries(rows:TrendEntryResult[]){
  return (['body-only','wick-only','both','neither'] as const).map(group=>{
    const selected=rows.filter(r=>r.group===group),known=selected.filter(r=>r.net!==null),net=known.reduce((s,r)=>s+r.net!,0),complete=known.length===selected.length&&selected.length>0;
    return {group,count:selected.length,days:new Set(selected.map(r=>centralDay(r.entry))).size,net:complete?net:null,average:complete?net/selected.length:null,winRate:complete?known.filter(r=>r.net!>0).length/selected.length:null,unknownCosts:selected.length-known.length};
  });
}
