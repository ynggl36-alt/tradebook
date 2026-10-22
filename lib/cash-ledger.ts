import type {CashRecord} from './types';
import type {BalanceAdjustment} from './balance-adjustments';
import {unrecordedPayouts} from './balance-adjustments';
import {payoutProceeds} from './payouts';

// One display model for every payout. Source records remain attached only for
// audit and cost editing; provenance does not change layout, labels or totals.
export type CashLedgerRow={id:string;date:string;account:string;kind:CashRecord['kind'];amount:number|null;note:string;record?:CashRecord;adjustment?:BalanceAdjustment};

export function cashLedgerRows(cash:CashRecord[],adjustments:BalanceAdjustment[]):CashLedgerRow[]{
 const recorded:CashLedgerRow[]=cash.map(record=>({id:'recorded:'+record.id,date:record.date,account:record.account,kind:record.kind,
  amount:record.kind==='payout'?payoutProceeds(record).gross:record.expense===null?null:-record.expense,
  note:record.firmPayout&&record.note===record.firmPayout.firm+' payout history'?'':record.note,record}));
 // Preserve the globally computed overlap exclusions even when a saved payout
 // is outside the user's current date/account selection.
 const detected:CashLedgerRow[]=unrecordedPayouts(adjustments).map(adjustment=>({id:'detected:'+adjustment.id,date:adjustment.date,account:adjustment.account,kind:'payout',amount:-adjustment.amount!,note:adjustment.note,adjustment}));
 return [...recorded,...detected].sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
}

export function cashLedgerSummary(rows:CashLedgerRow[]){
 const payouts=rows.filter(row=>row.kind==='payout'),known=payouts.filter(row=>row.amount!==null);
 return {count:payouts.length,knownAmounts:known.length,unknownAmounts:payouts.length-known.length,
  gross:payouts.length&&known.length===payouts.length?known.reduce((total,row)=>total+Math.round(row.amount!*100),0)/100:null};
}
