import type {CashRecord} from './types';
import type {BalanceAdjustment} from './balance-adjustments';
import {unrecordedPayouts} from './balance-adjustments';
import {payoutProceeds} from './payouts';

export type CashLedgerRow=
 | {id:string;date:string;account:string;source:'recorded';record:CashRecord}
 | {id:string;date:string;account:string;source:'detected';adjustment:BalanceAdjustment};

// Detection is a source of payout rows, not a second cash ledger. Retain the
// globally computed overlap exclusions even when a saved record is filtered out.
export function cashLedgerRows(cash:CashRecord[],adjustments:BalanceAdjustment[]):CashLedgerRow[]{
 const recorded:CashLedgerRow[]=cash.map(record=>({id:'recorded:'+record.id,date:record.date,account:record.account,source:'recorded',record}));
 const detected:CashLedgerRow[]=unrecordedPayouts(adjustments).map(adjustment=>({id:'detected:'+adjustment.id,date:adjustment.date,account:adjustment.account,source:'detected',adjustment}));
 return [...recorded,...detected].sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
}

export function cashLedgerSummary(rows:CashLedgerRow[]){
 const payouts=rows.flatMap<{gross:number|null;expected:number|null;actual:number|null;detected:boolean;automatic:boolean}>(row=>row.source==='detected'?[{gross:-row.adjustment.amount!,expected:row.adjustment.expectedShare,actual:null,detected:true,automatic:row.adjustment.source!=='owner'}]:row.record.kind==='payout'?[{...payoutProceeds(row.record),detected:false,automatic:false}]:[]);
 const sum=(values:number[])=>values.reduce((total,value)=>total+Math.round(value*100),0)/100;
 const knownGross=payouts.filter(row=>row.gross!==null),knownShares=payouts.filter(row=>row.expected!==null),receipts=payouts.filter(row=>row.actual!==null);
 const deductions=rows.flatMap(row=>row.source==='detected'?[-row.adjustment.amount!]:row.record.kind==='payout'&&row.record.deduction!==null?[row.record.deduction]:[]);
 return {count:payouts.length,detectedCount:payouts.filter(row=>row.detected).length,automaticCount:payouts.filter(row=>row.automatic).length,knownGross:knownGross.length,unknownShares:payouts.length-knownShares.length,
  gross:knownGross.length?sum(knownGross.map(row=>row.gross!)):null,
  expected:payouts.length&&knownShares.length===payouts.length?sum(knownShares.map(row=>row.expected!)):null,
  actual:receipts.length?sum(receipts.map(row=>row.actual!)):null,receivedCount:receipts.length,deductions:deductions.length?sum(deductions):null};
}
