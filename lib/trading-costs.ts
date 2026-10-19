import type {Trade} from './types';
import {centralDay,round} from './analytics';
// Published on this date; older trades stay unknown rather than using today's
// fee table retrospectively. Lucid account prefixes are the ones in this journal.
export const LUCID_RATES_AS_OF='2026-08-26';
export const LUCID_RATES_URL='https://support.lucidtrading.com/en/articles/11508978-approved-products-and-commissions';
export const LUCID_PER_SIDE:Record<string,number>={NQ:1.75,MNQ:.5,ES:1.75,MES:.5};
export function tradeCommission(trade:Trade):number|null{
 if(!/^(LFE|LFF)/i.test(trade.account)||centralDay(trade.entry)<LUCID_RATES_AS_OF)return null;
 const perSide=LUCID_PER_SIDE[trade.symbol];if(perSide===undefined||!Number.isSafeInteger(trade.qty)||trade.qty<=0)return null;
 // Every flat-to-flat trade exits the same quantity it entered, including all
 // scaled entries and partial exits. A reversal is already split at flat.
 return round(trade.qty*2*perSide);
}
export function netTradePnl(trade:Trade):number|null{const cost=tradeCommission(trade);return cost===null?null:round(trade.pnl-cost);}
export function netTradeSummary(trades:Trade[]){
 const known=trades.filter(t=>tradeCommission(t)!==null),commissions=round(known.reduce((s,t)=>s+tradeCommission(t)!,0));
 return {known:known.length,unknown:trades.length-known.length,commissions,complete:trades.length>0&&known.length===trades.length,
  net:known.length===trades.length&&trades.length?round(trades.reduce((s,t)=>s+t.pnl,0)-commissions):null,
  trades:known.map(t=>({...t,pnl:netTradePnl(t)!}))};
}
