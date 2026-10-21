import type {Journal} from './types';
import {accountStage} from './lucid-flex';

export type PerformanceStage='all'|'funded'|'evaluation';
export const PERFORMANCE_STAGES=[{value:'all',label:'Both'},{value:'funded',label:'Funded'},{value:'evaluation',label:'Evaluations'}] as const;

// This is the existing account classification, not a reconstruction of an
// account's stage at each historical fill. Status (e.g. Upgraded) is not a stage.
export function performanceAccountStages(journal:Journal):ReadonlyMap<string,string>{
 const profiles=new Map(journal.profiles.map(row=>[row.account,row])),references=new Map((journal.firmReferences||[]).map(row=>[row.account,row]));
 const names=new Set([...journal.accounts,...journal.trades,...(journal.realized||[]),...(journal.realizedSessions||[]),...journal.profiles,...(journal.firmReferences||[])].map(row=>row.account));
 return new Map([...names].map(account=>[account,accountStage(account,profiles.get(account),references.get(account))]));
}
export function matchesPerformanceStage(account:string,stage:PerformanceStage,stages:ReadonlyMap<string,string>){
 if(stage==='all')return true;
 // Newly connected accounts can precede their first saved execution. Do not
 // infer native-account membership from the subset of completed trades.
 return (stages.get(account)??accountStage(account))===(stage==='funded'?'Funded':'Evaluation');
}
export function scopePerformance(journal:Journal,stage:PerformanceStage,account='all',symbol='all',stageSource=journal){
 const stages=performanceAccountStages(stageSource),selectedAccount=account==='all'||matchesPerformanceStage(account,stage,stages)?account:'all';
 const selected=(row:{account:string;symbol:string})=>(selectedAccount==='all'||row.account===selectedAccount)&&(symbol==='all'||row.symbol===symbol)&&matchesPerformanceStage(row.account,stage,stages);
 return {stages,account:selectedAccount,accounts:journal.accounts.filter(row=>matchesPerformanceStage(row.account,stage,stages)),trades:journal.trades.filter(selected),realized:(journal.realized||[]).filter(selected),sessions:(journal.realizedSessions||[]).filter(selected)};
}
export function performanceAccountLabel(stage:PerformanceStage){return stage==='funded'?'All funded accounts':stage==='evaluation'?'All evaluation accounts':'All accounts';}
