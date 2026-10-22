import {trendValueAt} from './trendlines';
import type {PreparedTrends,TrendCandle,TrendEntry,TrendEntryResult,TrendLine,TrendSnapshot,TrendStyle} from './trendlines';

export const ATTRIBUTION_VERSION='trendline-interaction-v2';
export type EntryStyle='anticipatory'|'contact'|'after-rejection';
export type EvidenceStrength='strong'|'possible'|'unclassified';
export const ENTRY_STYLE_LABELS:Record<EntryStyle,string>={anticipatory:'Anticipatory candidate',contact:'Contact-price entry','after-rejection':'After rejection'};
export const EVIDENCE_LABELS:Record<EvidenceStrength,string>={strong:'Observed sequence',possible:'Inferred timing',unclassified:'Context only'};
export const ATTRIBUTION_REASONS:Record<string,string>={
  'pre-entry-sequence':'A completed contact candle was followed by a separate completed close away before entry.',
  'contact-price':'The actual first fill was within the line’s contact band.',
  'approach-only':'Price approached the line; no contact was observed in the last six completed minutes.',
  'approach-observed':'The recorded approach moved toward the line from the expected side.',
  'weak-approach':'The approach was not clear enough for stronger evidence.',
  'prior-test':'The line had an independent test before this approach began.',
  'two-anchors':'No independent test could be established before this approach began.',
  'late-availability':'The line only became confirmable during the approach.',
  'inferred-timing':'The entry-minute path is unknown; anticipation and intent remain inferred.',
  'intraminute-unknown':'The fill establishes price alignment, not whether this was the first touch or a same-minute rejection.',
  'sloping-contact-ambiguity':'The line moves materially during the contact minute; its OHLC range cannot time the touch precisely.',
  'competing-sequences':'Nearby line variants fit different entry styles; the timing attribution stays possible.',
  'near-only':'A direction-compatible line was nearby without a qualifying approach or completed rejection sequence.',
  'recent-break':'A recent one-minute close crossed the line’s contact band; a reclaim or break/retest needs a separate rule.',
  'no-match':'No selected direction-compatible line met the fixed interaction rules.',
  'missing-direction':'Canonical trade direction is unavailable.',
  'missing-fill':'The actual first allocated fill is unavailable.',
  'missing-prices':'Twenty consecutive completed pre-entry minutes are unavailable or incompatible.',
  'weak-structure':'A nearby exploratory path lacks a prominent origin or enough independent tests before the approach; it is proximity context only.',
  'missing-geometry':'Complete 5m/15m geometry is unavailable, even if one-minute timing prices exist.',
  'partial-geometry':'Only one of the 5m/15m geometry windows was available; the other timeframe remains unchecked.',
  'role-reversal':'The original line broke, then a later completed retest and separate close away established the opposite role before entry.',
};
export type TrendMatch={lineId:string;equivalentLineIds:string[];anchorStyles:TrendStyle[];minutes:number;polarity:'support'|'resistance';style:EntryStyle;confidence:EvidenceStrength;distance:number;linePrice:number;approachAt:number;contactAt:number|null;rejectedAt:number|null;rejectionPrice:number|null;priorTests:number;reasons:string[];flip?:TrendLine['flip']};
export type TrendAttribution={version:string;status:'matched'|'near-only'|'unclassified'|'unavailable';confidence:EvidenceStrength;style:EntryStyle|null;alternativeStyles:EntryStyle[];contactBand:number|null;entryBand:number|null;rejectionBand:number|null;match:TrendMatch|null;alternatives:{lineId:string;style:EntryStyle;confidence:EvidenceStrength}[];families:number;ambiguous:boolean;reasons:string[]};
const MINUTE=60000;
const strength=(s:EvidenceStrength)=>s==='strong'?2:s==='possible'?1:0;
const stylePriority=(s:EntryStyle)=>s==='after-rejection'?3:s==='contact'?2:1;
const direction=(line:TrendLine)=>line.polarity==='support'?1:-1;
const signedClose=(b:TrendCandle,line:TrendLine)=>direction(line)*(b.close-trendValueAt(line,b.end));
const localBand=(b:TrendCandle)=>Math.max(.5,.1*(b.atr??0));
function rangeReaches(b:TrendCandle,line:TrendLine){
  const a=trendValueAt(line,b.start),z=trendValueAt(line,b.end),band=localBand(b);
  return Number.isFinite(a)&&Number.isFinite(z)&&b.low<=Math.max(a,z)+band&&b.high>=Math.min(a,z)-band&&signedClose(b,line)>=-band;
}
function approach(bars:TrendCandle[],before:number,line:TrendLine,target:number,band:number){
  const prefix=bars.filter(b=>b.end<=before).slice(-3),distances=prefix.map(b=>signedClose(b,line));
  const steps=[...distances,target];let toward=0;for(let i=1;i<steps.length;i++)if(steps[i]<steps[i-1])toward++;
  const clear=prefix.length===3&&distances.every(Number.isFinite)&&distances.every(d=>d>=-band)&&distances[0]>band*1.5&&distances[0]-target>=band&&toward>=2;
  return {clear,start:prefix[0]?.start??before,available:!!prefix.length&&line.availableAt<=prefix[0].start};
}
function testsBefore(prepared:PreparedTrends,line:TrendLine,before:number){
  const bars=prepared.streams.find(s=>s.minutes===line.minutes)?.bars??[];let count=0,last=-100;
  const episodeStart=line.flip?.retestAt??line.b.time-line.minutes*MINUTE/2;
  let lo=0,hi=bars.length;while(lo<hi){const mid=(lo+hi)>>>1;if(bars[mid].start<episodeStart)lo=mid+1;else hi=mid;}
  last=lo;
  for(let i=lo;i<bars.length;i++){
    const b=bars[i];if(b.end>before)break;
    const value=trendValueAt(line,(b.start+b.end)/2),tol=Math.max(1,.25*(b.atr??0));
    if(Math.abs(line.slope*(b.end-b.start))>tol)continue;
    const wick=line.polarity==='support'?b.low:b.high,body=line.polarity==='support'?Math.min(b.open,b.close):Math.max(b.open,b.close);
    if(Math.abs(wick-value)<=tol||Math.abs(body-value)<=tol){if(b.start>=line.availableAt&&i-last>=3)count++;last=i;}
  }
  return count;
}
function compare(a:TrendMatch,b:TrendMatch){return strength(b.confidence)-strength(a.confidence)||stylePriority(b.style)-stylePriority(a.style)||a.distance-b.distance||a.lineId.localeCompare(b.lineId);}
function equivalent(a:TrendLine,b:TrendLine,at:number,band:number){return a.polarity===b.polarity&&[at,at-10*MINUTE].every(time=>Math.abs(trendValueAt(a,time)-trendValueAt(b,time))<=band);}
export function attributeTrendEntry(entry:Pick<TrendEntry,'entry'|'entryPrice'|'contract'|'dir'>,snapshot:TrendSnapshot,prepared:PreparedTrends):TrendAttribution{
  const result:TrendAttribution={version:ATTRIBUTION_VERSION,status:'unavailable',confidence:'unclassified',style:null,alternativeStyles:[],contactBand:null,entryBand:null,rejectionBand:null,match:null,alternatives:[],families:0,ambiguous:false,reasons:[]};
  if(entry.entryPrice===null||!Number.isFinite(entry.entryPrice)||entry.entryPrice<=0){result.reasons=['missing-fill'];return result;}
  if(entry.dir!=='Long'&&entry.dir!=='Short'){result.reasons=['missing-direction'];return result;}
  const at=Date.parse(entry.entry),cutoff=Math.floor(at/MINUTE)*MINUTE;
  let lo=0,hi=prepared.minuteBars.length;while(lo<hi){const mid=(lo+hi)>>>1;if(prepared.minuteBars[mid].end<=cutoff)lo=mid+1;else hi=mid;}
  const bars=prepared.minuteBars.slice(Math.max(0,lo-20),lo);
  if(!Number.isFinite(at)||snapshot.asOf!==cutoff||snapshot.contract!==entry.contract||prepared.contract!==entry.contract||snapshot.atr===null||!Number.isFinite(snapshot.atr)||snapshot.atr<0||bars.length!==20||bars.some((b,i)=>b.start!==cutoff-(20-i)*MINUTE||b.end!==b.start+MINUTE)||bars[0].segment!==bars.at(-1)!.segment){result.reasons=['missing-prices'];return result;}
  if(snapshot.status!=='measured'){result.reasons=['missing-geometry'];return result;}
  const band=Math.max(.5,.1*snapshot.atr),near=Math.max(1,.25*snapshot.atr),rejection=Math.max(near,.75*snapshot.atr);
  result.contactBand=band;result.entryBand=near;result.rejectionBand=rejection;
  const candidates:{line:TrendLine;match:TrendMatch}[]=[];let nearOnly=false,recentBreak=false,weakStructure=false;
  for(const line of snapshot.lines){
    if(![5,15].includes(line.minutes)||line.broken||line.availableAt>cutoff||line.asOf!==cutoff||!line.family.startsWith(entry.contract+'|')||line.polarity!==(entry.dir==='Long'?'support':'resistance'))continue;
    const linePrice=trendValueAt(line,at),distance=direction(line)*(entry.entryPrice-linePrice);
    if(!Number.isFinite(linePrice)||!Number.isFinite(distance)||distance< -band||distance>rejection)continue;
    if(line.structureValid===false){nearOnly=true;weakStructure=true;continue;}
    const recent=bars.slice(-6),contacts=recent.filter(b=>b.start>=line.availableAt&&rangeReaches(b,line));
    if(recent.some(b=>b.start>=line.availableAt&&signedClose(b,line)<-localBand(b))){recentBreak=true;if(distance<=near)nearOnly=true;continue;}
    let style:EntryStyle|null=null,contactAt:number|null=null,rejectedAt:number|null=null,rejectionPrice:number|null=null;
    let trace=approach(bars,cutoff,line,distance,band);
    if(Math.abs(distance)<=band){style='contact';}
    else{
      // A new contact supersedes an older reaction. Never reach back past an
      // unresolved recontact to justify an after-rejection label.
      const contact=contacts.at(-1);
      if(contact){
        const later=bars.filter(b=>b.start>=contact.end&&b.end<=Math.min(cutoff,contact.end+3*MINUTE)),away=Math.max(1,.25*(contact.atr??0));
        const rejected=later.find(b=>signedClose(b,line)>=away);
        if(later.length&&rejected&&!bars.filter(b=>b.start>=contact.end).some(b=>signedClose(b,line)<-localBand(b))&&distance>=band&&signedClose(bars.at(-1)!,line)>=away){
          style='after-rejection';contactAt=contact.start;rejectedAt=rejected.end;rejectionPrice=rejected.close;
          trace=approach(bars,contact.start,line,0,localBand(contact));
        }
      }
      if(!style&&distance<=near&&trace.clear&&contacts.length===0)style='anticipatory';
    }
    if(!style){if(distance<=near)nearOnly=true;continue;}
    const contactBar=contactAt===null?null:bars.find(b=>b.start===contactAt),slopingContact=!!contactBar&&Math.abs(line.slope*MINUTE)>localBand(contactBar);
    const priorTests=testsBefore(prepared,line,trace.start),strong=style!=='anticipatory'&&trace.clear&&trace.available&&priorTests>0&&!slopingContact;
    const requiredTests=line.flip?1:line.structureBasis==='tested-continuation'?2:1;
    if(!trace.clear||!trace.available||priorTests<requiredTests||(line.structureAt??line.availableAt)>trace.start){nearOnly=true;weakStructure=true;continue;}
    const reasons=[style==='after-rejection'?'pre-entry-sequence':style==='contact'?'contact-price':'approach-only',trace.clear?'approach-observed':'weak-approach',priorTests>0?'prior-test':'two-anchors'];
    if(!trace.available)reasons.push('late-availability');
    if(slopingContact)reasons.push('sloping-contact-ambiguity');
    if(style==='anticipatory')reasons.push('inferred-timing');if(style==='contact')reasons.push('intraminute-unknown');
    if(line.flip)reasons.push('role-reversal');
    candidates.push({line,match:{lineId:line.id,equivalentLineIds:[line.id],anchorStyles:[line.style],minutes:line.minutes,polarity:line.polarity,style,confidence:strong?'strong':'possible',distance:Math.abs(distance),linePrice,approachAt:trace.start,contactAt,rejectedAt,rejectionPrice,priorTests,reasons,...(line.flip?{flip:line.flip}:{})}});
  }
  // Similar paths are one hypothesis, including across anchor pairs/timeframes.
  // Group membership and the number of candidates never increase confidence.
  candidates.sort((a,b)=>compare(a.match,b.match));
  const families:{line:TrendLine;match:TrendMatch}[]=[];
  for(const candidate of candidates){
    const family=families.find(f=>equivalent(f.line,candidate.line,at,band));
    if(family){family.match.equivalentLineIds.push(candidate.line.id);if(!family.match.anchorStyles.includes(candidate.line.style))family.match.anchorStyles.push(candidate.line.style);}
    else families.push({line:candidate.line,match:{...candidate.match,equivalentLineIds:[...candidate.match.equivalentLineIds],anchorStyles:[...candidate.match.anchorStyles]}});
  }
  result.families=families.length;
  const best=families[0]?.match;
  if(!best){result.status=nearOnly?'near-only':'unclassified';result.reasons=[nearOnly?'near-only':'no-match',...(weakStructure?['weak-structure']:[]),...(recentBreak?['recent-break']:[]),...(snapshot.geometry?.some(g=>!g.available)?['partial-geometry']:[])];return result;}
  result.alternativeStyles=[...new Set(candidates.filter(c=>c.match.style!==best.style&&c.match.confidence===best.confidence).map(c=>c.match.style))];
  result.ambiguous=result.alternativeStyles.length>0;
  if(result.ambiguous){best.confidence='possible';best.reasons.push('competing-sequences');}
  result.status='matched';result.match=best;result.style=best.style;result.confidence=best.confidence;result.reasons=best.reasons;
  if(snapshot.geometry?.some(g=>!g.available))result.reasons=[...result.reasons,'partial-geometry'];
  const alternatives=candidates.filter(c=>c.match.lineId!==best.lineId&&(c.match.style!==best.style||!equivalent(families[0].line,c.line,at,band)));
  result.alternatives=alternatives.slice(0,2).map(c=>({lineId:c.match.lineId,style:c.match.style,confidence:c.match.confidence}));
  return result;
}
export function summarizeAttributions(rows:TrendEntryResult[]){
  return (['anticipatory','contact','after-rejection'] as const).map(style=>{const selected=rows.filter(r=>r.attribution?.style===style&&!r.attribution.ambiguous);return {style,count:selected.length,strong:selected.filter(r=>r.attribution?.confidence==='strong').length,possible:selected.filter(r=>r.attribution?.confidence==='possible').length};});
}
// A balanced, outcome-blind review set: styles × evidence level, then unknowns.
// Date/contract-minute de-duplication avoids multiple accounts filling the set.
export function calibrationEntries(rows:TrendEntryResult[],limit=15){
  const ordered=[...rows].sort((a,b)=>a.entry.localeCompare(b.entry)||a.contract.localeCompare(b.contract)||a.id.localeCompare(b.id)),chosen:TrendEntryResult[]=[],seen=new Set<string>();
  const take=(accept:(r:TrendEntryResult)=>boolean,count:number)=>{const unique=new Map<string,TrendEntryResult>();for(const row of ordered){const key=row.contract+'|'+Math.floor(Date.parse(row.entry)/MINUTE);if(accept(row)&&!seen.has(key)&&!unique.has(key))unique.set(key,row);}const eligible=[...unique.values()];if(!eligible.length)return;for(let i=0;i<Math.min(count,eligible.length)&&chosen.length<limit;i++){const row=eligible[Math.min(eligible.length-1,Math.floor((i+.5)*eligible.length/Math.min(count,eligible.length)))],key=row.contract+'|'+Math.floor(Date.parse(row.entry)/MINUTE);if(!seen.has(key)){chosen.push(row);seen.add(key);}}};
  for(const style of ['anticipatory','contact','after-rejection'] as const)for(const confidence of ['strong','possible'] as const)take(r=>r.attribution?.style===style&&r.attribution.confidence===confidence&&!r.attribution.ambiguous,2);
  take(r=>!!r.attribution?.ambiguous,2);
  take(r=>r.attribution?.status==='near-only',2);take(r=>r.attribution?.status==='unclassified',2);
  take(r=>r.status==='measured',limit-chosen.length);
  return chosen.slice(0,limit);
}
