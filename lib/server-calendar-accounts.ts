import {env} from 'cloudflare:workers';
import {dayBalanceReport,validateDayBalanceRequest} from './calendar-accounts';
import type {DayBalanceRead} from './calendar-accounts';

export async function loadAccountDayBalances(input:Record<string,unknown>,asOf=Date.now()){
 const {day,start,end,accounts}=validateDayBalanceRequest(input),at=new Date(asOf).toISOString();
 if(!env.DB)throw new Error('Account balance history is unavailable.');
 const points:(DayBalanceRead&{account:string})[]=[];
 // At most 13 read-only queries, each below D1's parameter limit and using the
 // account/time index. Only two small endpoint records leave each account.
 for(let offset=0;offset<accounts.length;offset+=40){
  const chunk=accounts.slice(offset,offset+40);
  const endpoint=(direction:'ASC'|'DESC')=>`SELECT o.id FROM account_observations o
   WHERE o.account=requested.account AND captured_at>=? AND captured_at<? AND captured_at<=?
    AND origin='capture' AND cash_value IS NOT NULL
    AND json_extract(data,'$.state.currency')='USD' AND json_extract(data,'$.state.connected')=1
    AND json_extract(data,'$.state.values.CashValue.at')=captured_at
   ORDER BY captured_at ${direction} LIMIT 1`;
  // Two indexed seeks stop at the first eligible endpoint; do not rank/sort
  // every valid heartbeat on a capture-heavy day. UNION deduplicates one read.
  const result=await env.DB.prepare(`WITH requested(account) AS (VALUES ${chunk.map(()=>'(?)').join(',')}), endpoints(id) AS (
   SELECT (${endpoint('ASC')}) FROM requested UNION SELECT (${endpoint('DESC')}) FROM requested
  ) SELECT o.account,o.captured_at AS at,o.cash_value AS value,
    COALESCE(json_extract(o.data,'$.state.provider'),'') AS provider,COALESCE(json_extract(o.data,'$.state.connection'),'') AS connection
   FROM endpoints JOIN account_observations o ON o.id=endpoints.id ORDER BY o.account,o.captured_at`)
   .bind(...chunk,start,end,at,start,end,at).all<DayBalanceRead&{account:string}>();
  points.push(...result.results);
 }
 return dayBalanceReport(day,accounts,points,at);
}
