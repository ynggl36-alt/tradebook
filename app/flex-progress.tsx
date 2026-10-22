'use client';
import React from 'react';
import type {Journal,Trade} from '../lib/types';
import {FLEX_CONSISTENCY_URL,FLEX_DAILY_MIN,FLEX_EVAL_URL,FLEX_PAYOUT_URL,FLEX_RULES_CHECKED} from '../lib/lucid-flex';
import {accountFlexProgress} from '../lib/account-display';
import type {AccountFlexProgress} from '../lib/account-display';
import {dateLabel,money,num,signed} from './ui';
import {centralDay} from '../lib/analytics';

export function FlexProgress({account,journal,now=Date.now(),expanded=false,accountTrades,progress,compact=false}:{account:string;journal:Journal;now?:number;expanded?:boolean;accountTrades?:Trade[];progress?:AccountFlexProgress|null;compact?:boolean}){
 const model=progress===undefined?accountFlexProgress(account,journal,now,accountTrades):progress;
 if(!model)return null;
 const {payout,evaluation,stage}=model,funded=stage==='Funded',timingUnknown=payout.reason==='payout-time';
 const payoutNote=<p>{payout.reason==='payout-time'?'Trading occurred between the balance readings that bracket this payout. Its exact time is unknown, so only later qualifying days are confirmed.':payout.reason==='payout'?'A newer payout is recorded, but its deduction time is missing from balance history.':payout.reason==='approval-time'?'A recorded payout shares a date with the latest deduction; their order is unavailable in the saved history.':payout.reason==='baseline'?(payout.payoutResetAt?'Post-payout session history is incomplete; earlier profit is excluded.':'Session history is incomplete.'):payout.reason==='coverage'?'Execution history has an inventory gap. The day count remains unavailable.':payout.reason==='costs'?'Commission data is incomplete. The day count remains unavailable.':payout.payoutResetAt?<>Cycle reset after payout · {dateLabel(centralDay(payout.payoutResetAt),true)}. Qualifying days count from the observed deduction.</>:<>{money(FLEX_DAILY_MIN)} net or more per session. Counting from when this funded account opened.</>}</p>;

 const evaluationNote=<p>{evaluation.consistencyPercent===null?'$3,000 base target. Select your consistency option to calculate the adjusted target.':evaluation.target>3000?'Target increases with your largest net session to meet consistency. The firm’s final calculation may include its cushion.':'Consistency applies during evaluation. Final passing status comes from Lucid.'}</p>;
 return <section className={'flex-progress '+(funded?'funded':'evaluation')} aria-label={funded?'Funded account payout progress':'Evaluation progress'}>
  <div className="flex-progress-title"><span>{funded?'Next payout · profit days':'Evaluation · profit target'}</span>{funded&&<small>{num(payout.payoutCount)} {payout.payoutCount===1?'payout':'payouts'}</small>}</div>
  {funded?<>
   <div className="flex-progress-value"><strong>{payout.days??payout.confirmedDays}<small>{payout.days===null?' confirmed / 5 days':' / 5 days'}</small></strong><span>{payout.remaining===null?(timingUnknown?'Exact day count unavailable':'Waiting for latest P&L'):payout.remaining===0?'Day goal met':payout.remaining+' more qualifying '+(payout.remaining===1?'day':'days')}</span></div>
   <div className="flex-day-steps" aria-hidden="true">{Array.from({length:5},(_,i)=><span key={i} className={i<(payout.days??payout.confirmedDays)?'filled':''}/>)}</div>
   {payout.cycleProfit!==null&&<p className="flex-today">Cycle profit: {signed(payout.cycleProfit)}</p>}
   {compact?<details className="flex-progress-notes"><summary>Progress details</summary>{payoutNote}{payout.today!==null&&<p>Current session: {signed(payout.today)} net · provisional until the session ends.</p>}<p>Qualifying days measure progress, not final payout eligibility.</p></details>:payoutNote}
   {!compact&&payout.today!==null&&<p className="flex-today">{compact?'Session: ':'Current session: '}{signed(payout.today)} net · {compact?'provisional':'provisional until the session ends.'}</p>}
  </>:<>
   <div className="flex-progress-value"><strong>{money(evaluation.net)}<small> / {money(evaluation.target)}</small></strong></div>
   <progress max={evaluation.target} value={Math.max(0,evaluation.net??0)} aria-label="Net profit toward evaluation target"/>
   <div className="flex-eval-facts"><span>{evaluation.remaining===null?'Net progress unavailable':evaluation.remaining>0?money(evaluation.remaining)+' still needed':'Profit target reached'}</span><span>{evaluation.consistencyPercent===null?'Confirm 40% / 50% in Details':evaluation.consistency===null?'Consistency: waiting for net profit':evaluation.consistency.toFixed(2)+'% / '+evaluation.consistencyPercent+'% consistency'}</span></div>
   {compact?<details className="flex-progress-notes"><summary>Progress details</summary>{evaluationNote}</details>:evaluationNote}
  </>}
  {expanded&&<details className="flex-rule-details"><summary>Lucid Flex 50K rules & sources</summary><p>{funded?'Five sessions with at least $150 net, positive cycle profit, and a $500 minimum request. Requests are limited to 50% of profit, capped at $2,000. No funded consistency rule or payout buffer.':'$3,000 base profit target and a $2,000 end-of-day trailing loss limit. Evaluation consistency is 40%, or 50% with the account option.'}</p><p>Funded accounts start at zero profit days. Each session with at least $150 net adds one day. Verified platform P&L is used when available, with execution estimates for earlier history. Sessions begin at 5 PM Central. Current-session results can change. A completed day goal does not confirm payout eligibility, rule compliance or approval.</p><p>Payout deductions reset profit days and cycle profit automatically. The firm’s drawdown floor remains separate. Day counts are calculated automatically from trading sessions and payout deductions. Payout totals use the full recorded amount.</p><p><a href={funded?FLEX_PAYOUT_URL:FLEX_EVAL_URL} target="_blank" rel="noopener noreferrer">Official {funded?'payout':'evaluation'} rules</a>{!funded&&<> · <a href={FLEX_CONSISTENCY_URL} target="_blank" rel="noopener noreferrer">Consistency options</a></>} · checked {dateLabel(FLEX_RULES_CHECKED,true)}.</p></details>}
 </section>;
}
