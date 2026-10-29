import type {ReportedSession} from './account-sessions';
import type {FirmReference} from './firm-reference';
import type {RealizedDay,RealizedCheckpoint} from './realized';
import type {BalanceAdjustment,BalanceTracking,FirmAdjustmentNotice} from './balance-adjustments';
import type {EvaluationFailure} from './evaluation-failures';
export type Fill = {
  id: string; contract: string; symbol: string; pv: number; time: string;
  ordinal: number; side: 'Buy' | 'Sell'; qty: number; price: number;
  pos: number | null; entryFlag?: boolean | null;
};
export type Trade = {
  id: string; account: string; contract: string; symbol: string; dir: 'Long' | 'Short';
  entry: string; exit: string; qty: number; maxQty: number; avgEntry: number;
  avgExit: number; pnl: number; exitOrder: number;
  parts?: [string, number, number, string][];
};
export type HistoryIssue = {contract: string; reason: string; time: string; remaining: number};
export type AccountHistory = {account: string; fills: Fill[]; trades: Trade[]; issues: HistoryIssue[]; supersededTrades?:Trade[]};
export type AccountProfile = {account: string; label: string; stage: string; status: string; notes: string};
export type TradeNote = {id: string; account: string; setup: string; plan: string; note: string};
export type CashRecord = {
  id: string; kind: 'payout' | 'evaluation' | 'reset' | 'activation' | 'other';
  date: string; account: string; deduction: number | null; received: number | null;
  expense: number | null; note: string;
  firmPayout?:{firm:string;currency:'USD';amount:number;requestedDate:string;approvedDate:string;status:'Paid';source:string};
  // Historical source metadata is retained for backup compatibility only.
  payoutAmountBasis?:'gross-request'|'trader-share'|'unknown';
  payoutSplit?:number;
  payoutApprovalAt?:string;
};
export type CostRecord = CashRecord & {kind:Exclude<CashRecord['kind'],'payout'>};
export type ImportRecord = {id: string; source: string; added: number; duplicates: number; importedAt: string};
export type AccountSummary = {account: string; fills: number; issues: HistoryIssue[]; first: string; last: string};
export type Journal = {
  ready: boolean; trades: Trade[]; accounts: AccountSummary[]; profiles: AccountProfile[];
  notes: TradeNote[]; cash: CashRecord[]; imports: ImportRecord[];
  lastSaved: string; seedVersion: string; firmReferences?:FirmReference[];
  revision?:string; realized?:RealizedDay[];
  realizedSessions?:RealizedDay[];realizedCheckpoints?:RealizedCheckpoint[];
  reportedSessions?:ReportedSession[];reportedCheckpoints?:RealizedCheckpoint[];
  adjustments?:BalanceAdjustment[];balanceTracking?:BalanceTracking;firmAdjustments?:FirmAdjustmentNotice[];
  evaluationFailures?:EvaluationFailure[];
};
