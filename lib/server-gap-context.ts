import {env} from 'cloudflare:workers';
import type {AccountHistory} from './types';
import {reconstruct} from './reconstruct';
import {GAP_CONTEXT_BATCH,GAP_CONTEXT_VERSION,entryPriceRange,measureGapEntry} from './gap-context';
import type {GapEntryContext} from './gap-context';
import {loadPriceBars,loadWeeklyGapBars} from './server-prices';

export type GapTradeRef={account:string;id:string};
export type GapContextReport={version:string;rows:GapEntryContext[];missing:GapTradeRef[]};
export function validateGapReferences(input:unknown):GapTradeRef[]{
  if(!Array.isArray(input)||!input.length||input.length>GAP_CONTEXT_BATCH)throw new Error('Choose 1 to '+GAP_CONTEXT_BATCH+' completed trades per context request.');
  const seen=new Set<string>();
  return input.map(value=>{
    if(!value||typeof value!=='object')throw new Error('Invalid trade reference.');
    const {account,id}=value as GapTradeRef;
    if(typeof account!=='string'||!account.trim()||account.length>150||typeof id!=='string'||!id.trim()||id.length>150)throw new Error('A recorded account and trade ID are required.');
    const key=JSON.stringify([account,id]);if(seen.has(key))throw new Error('A trade reference is repeated.');seen.add(key);
    return {account,id};
  });
}

// Read only canonical allocations and archived prices. No inferred context is
// persisted into owner reviews, raw executions or financial records.
export async function loadGapContexts(input:unknown):Promise<GapContextReport>{
  const refs=validateGapReferences(input);
  if(!env.DB)throw new Error('Price storage is unavailable.');
  const accounts=[...new Set(refs.map(ref=>ref.account))],histories=new Map<string,AccountHistory>();
  // At most five small history reads plus two indexed price reads per trade:
  // <=45 SQL statements for a 20-trade request, within the free D1 limit.
  for(let offset=0;offset<accounts.length;offset+=4){
    const chunk=accounts.slice(offset,offset+4);
    const result=await env.DB.prepare(`SELECT account,data FROM account_history WHERE account IN (${chunk.map(()=>'?').join(',')})`).bind(...chunk).all<{account:string;data:string}>();
    for(const row of result.results){
      const history=JSON.parse(row.data) as AccountHistory;
      if(history.account===row.account)histories.set(row.account,await reconstruct(row.account,history.fills.filter(fill=>Date.parse(fill.time)<=Date.now())));
    }
  }
  const rows:GapEntryContext[]=[],missing:GapTradeRef[]=[];
  for(const ref of refs){
    const history=histories.get(ref.account),trade=history?.trades.find(t=>t.id===ref.id&&t.account===ref.account);
    if(!history||!trade){missing.push(ref);continue;}
    const range=entryPriceRange(trade.entry);
    const [before,boundaries]=await Promise.all([
      loadPriceBars(trade.contract,range.start,range.end-60000),
      loadWeeklyGapBars(trade.contract,Date.parse(trade.entry)),
    ]);
    rows.push(measureGapEntry(trade,history.fills,[...before,...boundaries]));
  }
  return {version:GAP_CONTEXT_VERSION,rows,missing};
}
