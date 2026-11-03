import type {Fill,HistoryIssue,Trade} from './types';
import {addDays,round} from './analytics';
import {flexSession,flexSessionStart} from './trading-session';

export type ExecutionEvent={fill:Fill;gross:number;quantity:number;unmatched:number;coverageIssues:number;coverageGapAt?:string};
type Episode=Omit<Trade,'id'|'account'>&{firstFillId:string;firstOffset:number};
export type ExecutionLedger={events:ExecutionEvent[];episodes:Episode[];issues:HistoryIssue[];positionConflicts:{fillId:string;contract:string;time:string;reported:number;calculated:number}[];nextUpdateAt?:number};

// One inventory/allocation pass supplies both exit accounting and completed
// positions. Position metadata can describe a missing opening inventory, but
// cannot subsequently create contracts, discard lots or change their prices.
export function executionLedger(fills:readonly Fill[],options:{intraday?:boolean;asOf?:number}={}):ExecutionLedger{
 const ledger:ExecutionLedger={events:[],episodes:[],issues:[],positionConflicts:[]},streams=new Map<string,{contract:string;session:string;fills:Fill[]}>();
 for(const fill of fills){const session=options.intraday?flexSession(fill.time):'',key=JSON.stringify([fill.contract,session]),source=streams.get(key)||{contract:fill.contract,session,fills:[]};source.fills.push(fill);streams.set(key,source);}
 for(const {contract,session,fills:source}of streams.values()){
  const boundary=session?Date.parse(flexSessionStart(addDays(session,1))):Infinity,closed=boundary<=(options.asOf??Date.now());
  // A capture's sequence survives partial imports/backfills. Use it only when
  // the complete same-clock group has distinct source sequences. It records
  // capture order, not proof of physical exchange ordering within a timestamp.
  const ties=new Map<number,Fill[]>();for(const fill of source){const at=Date.parse(fill.time),group=ties.get(at)||[];group.push(fill);ties.set(at,group);}
  const sequenced=new Set([...ties].filter(([,group])=>group.every(fill=>Number.isSafeInteger(fill.sourceSequence)&&fill.sourceSequence!>0)&&new Set(group.map(fill=>fill.sourceSequence)).size===group.length).map(([at])=>at));
  const fillOrder=(fill:Fill)=>sequenced.has(Date.parse(fill.time))?fill.sourceSequence!:fill.ordinal;
  const sorted=[...source].sort((a,b)=>Date.parse(a.time)-Date.parse(b.time)||fillOrder(a)-fillOrder(b)||a.id.localeCompare(b.id));
  let position=0,head=0,lots:{quantity:number;price:number|null}[]=[];
  let episode:null|{firstFillId:string;firstOffset:number;dir:'Long'|'Short';entry:string;exit:string;entryQty:number;exitQty:number;entryValue:number;exitValue:number;pnl:number;max:number;known:boolean;symbol:string;order:number;parts:NonNullable<Trade['parts']>}=null;
  const start=(fill:Fill,direction:number,known:boolean,offset:number)=>({firstFillId:fill.id,firstOffset:offset,dir:(direction>0?'Long':'Short')as 'Long'|'Short',entry:fill.time,exit:fill.time,entryQty:0,exitQty:0,entryValue:0,exitValue:0,pnl:0,max:Math.abs(position),known,symbol:fill.symbol,order:fillOrder(fill),parts:[] as NonNullable<Trade['parts']>});
  const finish=()=>{
   if(!episode)return;
   if(!episode.known||position!==0||episode.entryQty!==episode.exitQty||episode.entryQty===0)ledger.issues.push({contract,time:episode.entry,remaining:position,reason:position!==0?(closed?'Missing close at the end of an intraday session':'Unclosed position in available history'):'Missing entry in available history'});
   else ledger.episodes.push({firstFillId:episode.firstFillId,firstOffset:episode.firstOffset,contract,symbol:episode.symbol,dir:episode.dir,entry:episode.entry,exit:episode.exit,qty:episode.entryQty,maxQty:episode.max,avgEntry:episode.entryValue/episode.entryQty,avgExit:episode.exitValue/episode.exitQty,pnl:round(episode.pnl),exitOrder:episode.order,parts:episode.parts});
   episode=null;
  };
  for(let index=0;index<sorted.length;index++){
   const fill=sorted[index],sign=fill.side==='Buy'?1:-1,event:ExecutionEvent={fill,gross:0,quantity:0,unmatched:0,coverageIssues:0};
   if(index===0&&fill.pos!==null){
    const before=fill.pos-sign*fill.qty;
    if(before!==0){position=before;lots=[{quantity:Math.abs(before),price:null}];event.coverageIssues=1;}
   }
   if(!episode&&position!==0)episode=start(fill,position,false,0);
   if(position===0&&fill.entryFlag===false){
    event.quantity=fill.qty;event.unmatched=fill.qty;event.coverageIssues=1;
    ledger.issues.push({contract,time:fill.time,remaining:0,reason:'Exit without an entry in the available history'});
   }else{
    let remaining=fill.qty,offset=0;
    while(remaining>0){
     const opening=position===0||position*sign>0;
     if(!episode)episode=start(fill,sign,true,offset);
     const quantity=opening?remaining:Math.min(remaining,Math.abs(position));
     if(opening){lots.push({quantity,price:fill.price});episode.entryQty+=quantity;episode.entryValue+=quantity*fill.price;}
     else{
      let closing=quantity;
      while(closing>0){
       const lot=lots[head];if(!lot)throw new Error('Execution inventory is inconsistent.');
       const part=Math.min(closing,lot.quantity);
       if(lot.price===null){event.unmatched+=part;episode.known=false;}
       else{const gross=round((fill.price-lot.price)*(position>0?1:-1)*part*fill.pv);event.gross+=gross;episode.pnl+=gross;}
       lot.quantity-=part;closing-=part;if(lot.quantity===0)head++;
      }
      event.quantity+=quantity;episode.exitQty+=quantity;episode.exitValue+=quantity*fill.price;
     }
     episode.parts.push([fill.id,quantity,fill.price,fill.side]);position+=sign*quantity;episode.max=Math.max(episode.max,Math.abs(position));episode.exit=fill.time;episode.order=fillOrder(fill);
     remaining-=quantity;offset+=quantity;
     if(position===0){finish();lots=[];head=0;}
    }
   }
   if(event.unmatched)event.coverageIssues=1;
   if(fill.pos!==null&&fill.pos!==position)ledger.positionConflicts.push({fillId:fill.id,contract,time:fill.time,reported:fill.pos,calculated:position});
   event.gross=round(event.gross);ledger.events.push(event);
  }
  // A final claimed flat position cannot certify an unbalanced execution
  // stream. Keep its result incomplete without inventing the missing fills.
  if(position!==0&&sorted.at(-1)?.pos===0)ledger.events.at(-1)!.coverageIssues=1;
  if(position!==0&&options.intraday){
   // This is coverage evidence effective at the session boundary, not a fill.
   // Earlier verified prefixes keep their economic values and raw identity.
   if(closed)ledger.events.at(-1)!.coverageGapAt=new Date(boundary).toISOString();
   else ledger.nextUpdateAt=Math.min(ledger.nextUpdateAt??Infinity,boundary);
  }
  finish();
 }
 ledger.events.sort((a,b)=>Date.parse(a.fill.time)-Date.parse(b.fill.time)||a.fill.ordinal-b.fill.ordinal||a.fill.contract.localeCompare(b.fill.contract)||a.fill.id.localeCompare(b.fill.id));
 return ledger;
}

// The owner's journal contains intraday futures accounts. Generic simulator and
// overnight calculations opt out by continuing to use executionLedger directly.
export const journalExecutionLedger=(fills:readonly Fill[],asOf=Date.now())=>executionLedger(fills,{intraday:true,asOf});
