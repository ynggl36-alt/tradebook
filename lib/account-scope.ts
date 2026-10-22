import type {Trade} from './types';
import {centralDay} from './analytics';
import {flexSession} from './lucid-flex';
export type AccountScope={start:string;end:string;symbol?:string;label?:string;basis?:'calendar'|'session'};
export function accountScopeTrades(trades:Trade[],account:string,scope:AccountScope){
 return trades.filter(trade=>{
  if(trade.account!==account)return false;
  const day=scope.basis==='session'?flexSession(trade.exit):centralDay(trade.exit);
  return day>=scope.start&&day<=scope.end&&(!scope.symbol||scope.symbol==='all'||trade.symbol===scope.symbol);
 });
}
