import type { AccountHistory, Fill, Trade } from './types';
import {executionLedger,journalExecutionLedger} from './execution-ledger';

async function tradeId(account:string, contract:string, id:string, offset:number) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode([account,contract,id,String(offset)].join('|')));
  return 'T-'+Array.from(new Uint8Array(bytes)).map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,20);
}
export function sameFill(a:Fill,b:Fill){
  // Native execution exports can display less timestamp precision than the database.
  return a.id===b.id&&a.contract===b.contract&&a.side===b.side&&a.qty===b.qty&&Math.abs(a.price-b.price)<1e-8&&Math.floor(Date.parse(a.time)/1000)===Math.floor(Date.parse(b.time)/1000);
}
export function mergeFills(existing:Fill[],incoming:Fill[]) {
  const map=new Map(existing.map(f=>[f.id,f]));let added=0,duplicates=0,updated=0;const conflicts:string[]=[];
  let ordinal=Math.max(0,...existing.map(f=>f.ordinal));
  for(const row of incoming){const old=map.get(row.id);if(old){if(sameFill(old,row)){duplicates++;if(old.sourceSequence===undefined&&row.sourceSequence!==undefined){map.set(row.id,{...old,sourceSequence:row.sourceSequence});updated++;}else if(old.sourceSequence!==undefined&&row.sourceSequence!==undefined&&old.sourceSequence!==row.sourceSequence)conflicts.push(row.id);}else conflicts.push(row.id);}else{map.set(row.id,{...row,ordinal:++ordinal});added++;}}
  return {updated,fills:[...map.values()].sort((a,b)=>a.time.localeCompare(b.time)||a.ordinal-b.ordinal),added,duplicates,conflicts};
}
export async function reconstruct(account:string,fills:Fill[],ledger=executionLedger(fills)):Promise<AccountHistory>{
 const trades=await Promise.all(ledger.episodes.map(async({firstFillId,firstOffset,...episode})=>({...episode,account,id:await tradeId(account,episode.contract,firstFillId,firstOffset)})));
 return {account,fills,trades:trades.sort((a,b)=>a.entry.localeCompare(b.entry)||a.id.localeCompare(b.id)),issues:ledger.issues};
}

// Compatibility evidence is separate from current calculations. A corrected
// episode may replace an older grouping; keep its old ID/notes addressable even
// after ordinary imports rebuild the current history.
export function retainSupersededTrades(previous:AccountHistory,current:AccountHistory,previousProjection:readonly Trade[]=previous.trades):AccountHistory{
 const currentIds=new Set(current.trades.map(trade=>trade.id)),retained=new Map((previous.supersededTrades||[]).map(trade=>[trade.id,trade]));
 for(const trade of [...previous.trades,...previousProjection])if(!currentIds.has(trade.id))retained.set(trade.id,trade);
 for(const id of currentIds)retained.delete(id);
 return retained.size?{...current,supersededTrades:[...retained.values()]}:current;
}

export const reconstructJournal=(account:string,fills:Fill[],asOf=Date.now())=>reconstruct(account,fills,journalExecutionLedger(fills,asOf));
