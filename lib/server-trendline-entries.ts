import {env} from 'cloudflare:workers';
import type {AccountHistory} from './types';
import {firstEntryFill} from './gap-context';
import {netTradePnl} from './trading-costs';
import {inTrendPilot,TREND_BATCH,TREND_VERSION} from './trendlines';
import type {TrendEntry} from './trendlines';
export type TrendTradeRef={account:string;id:string};
export type TrendEntriesResponse={version:string;rows:TrendEntry[];missing:TrendTradeRef[]};
export function validateTrendReferences(input:unknown):TrendTradeRef[]{
  if(!Array.isArray(input)||!input.length||input.length>TREND_BATCH)throw new Error('Choose 1 to '+TREND_BATCH+' pilot trades per request.');
  const seen=new Set<string>();
  return input.map(value=>{
    if(!value||typeof value!=='object')throw new Error('Invalid trade reference.');
    const {account,id}=value as TrendTradeRef;
    if(typeof account!=='string'||!account.trim()||account.length>150||typeof id!=='string'||!id.trim()||id.length>150)throw new Error('A recorded account and trade ID are required.');
    const key=JSON.stringify([account,id]);if(seen.has(key))throw new Error('A trade reference is repeated.');seen.add(key);return {account,id};
  });
}
// At most 10 read-only SQL statements. Canonical allocation validation happens
// here; client trade averages or later scale-ins are never entry-price fallbacks.
export async function loadTrendEntries(input:unknown):Promise<TrendEntriesResponse>{
  const refs=validateTrendReferences(input);if(!env.DB)throw new Error('Journal storage is unavailable.');
  const accounts=[...new Set(refs.map(r=>r.account))],histories=new Map<string,AccountHistory>();
  for(let offset=0;offset<accounts.length;offset+=4){
    const chunk=accounts.slice(offset,offset+4),result=await env.DB.prepare(`SELECT account,data FROM account_history WHERE account IN (${chunk.map(()=>'?').join(',')})`).bind(...chunk).all<{account:string;data:string}>();
    for(const row of result.results){const history=JSON.parse(row.data) as AccountHistory;if(history.account===row.account)histories.set(row.account,history);}
  }
  const rows:TrendEntry[]=[],missing:TrendTradeRef[]=[];
  for(const ref of refs){
    const history=histories.get(ref.account),trade=history?.trades.find(t=>t.id===ref.id&&t.account===ref.account);
    if(!trade||!history||!inTrendPilot(trade.entry)||!/^(NQ|MNQ|ES|MES) 20\d{2}-(0[1-9]|1[0-2])$/.test(trade.contract)){missing.push(ref);continue;}
    rows.push({id:trade.id,account:trade.account,contract:trade.contract,entry:trade.entry,entryPrice:firstEntryFill(trade,history.fills)?.price??null,gross:trade.pnl,net:netTradePnl(trade)});
  }
  return {version:TREND_VERSION,rows,missing};
}
