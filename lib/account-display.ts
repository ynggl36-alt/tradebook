import type {AccountState} from './account-state';
import type {AccountProfile,Journal,Trade} from './types';
import {cashLedgerRows} from './cash-ledger';
import {centralDay} from './analytics';
import {accountStage,flexAccount,flexEvaluation,flexPayoutDays} from './lucid-flex';

export function accountFlexProgress(account:string,journal:Journal,now=Date.now(),accountTrades?:Trade[],profile?:AccountProfile){
 const reference=journal.firmReferences?.find(row=>row.account===account);
 const stage=accountStage(account,profile??journal.profiles.find(row=>row.account===account),reference);
 if(!flexAccount(account)||(stage!=='Funded'&&stage!=='Evaluation'))return null;
 const trades=accountTrades??journal.trades.filter(trade=>trade.account===account);
 const ledger={reportedSessions:journal.reportedSessions,reportedCheckpoints:journal.reportedCheckpoints,adjustments:journal.adjustments,sessions:journal.realizedSessions?.filter(row=>row.account===account),checkpoints:journal.realizedCheckpoints?.filter(row=>row.account===account)};
 const currentDay=centralDay(new Date(now).toISOString());
 const payoutCount=cashLedgerRows(journal.cash,journal.adjustments||[]).filter(row=>row.kind==='payout'&&row.account===account&&row.date<=currentDay).length;
 return {stage,payout:{...flexPayoutDays(account,trades,journal.cash,now,ledger),payoutCount},evaluation:flexEvaluation(trades,reference?.flex?.consistencyPercent??null,ledger)};
}
export type AccountFlexProgress=NonNullable<ReturnType<typeof accountFlexProgress>>;
export type AccountCard={state:AccountState;profile:AccountProfile|undefined;stage:string;progress:AccountFlexProgress|null};
const terminal=new Set(['Failed','Upgraded','Retired']);
function compareKnown(a:number|null|undefined,b:number|null|undefined){
 if(a==null||b==null)return a==null?b==null?0:1:-1;
 return a-b;
}
function compareCards(a:AccountCard,b:AccountCard){
 const archived=Number(terminal.has(a.profile?.status||''))-Number(terminal.has(b.profile?.status||''));
 if(archived)return archived;
 if(a.stage==='Funded'&&b.stage==='Funded'){
  const days=compareKnown(a.progress?.payout.remaining,b.progress?.payout.remaining);
  if(days)return days;
 }
 if(a.stage==='Evaluation'&&b.stage==='Evaluation'){
  // An unselected consistency option is only a base target estimate.
  const confirmed=Number(a.progress?.evaluation.consistencyPercent==null)-Number(b.progress?.evaluation.consistencyPercent==null);
  if(confirmed)return confirmed;
  const profit=compareKnown(a.progress?.evaluation.remaining,b.progress?.evaluation.remaining);
  if(profit)return profit;
 }
 return a.state.account.localeCompare(b.state.account);
}
export function accountCardGroups(accounts:AccountState[],journal:Journal,profiles:Map<string,AccountProfile>,now=Date.now(),tradesByAccount?:Map<string,Trade[]>){
 const cards:AccountCard[]=accounts.map(state=>{
  const profile=profiles.get(state.account),reference=journal.firmReferences?.find(row=>row.account===state.account);
  return {state,profile,stage:accountStage(state.account,profile,reference),progress:accountFlexProgress(state.account,journal,now,tradesByAccount?.get(state.account),profile)};
 });
 return [
  {stage:'Funded',title:'Funded accounts',description:'Closest by qualifying days · incomplete history last'},
  {stage:'Evaluation',title:'Evaluation accounts',description:'Closest to the profit target · unconfirmed targets last'},
  {stage:'Unclassified',title:'Other accounts',description:'Account stage needs classification'},
 ].map(group=>({...group,accounts:cards.filter(card=>group.stage==='Unclassified'?!['Funded','Evaluation'].includes(card.stage):card.stage===group.stage).sort(compareCards)})).filter(group=>group.accounts.length>0);
}
