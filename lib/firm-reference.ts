export type FlexCheckpoint={stage:'Evaluation'|'Funded';consistencyPercent:40|50|null;qualifyingDays:number|null;capturedAt:string;coveredPayoutIds?:string[]};
export type FirmReference={account:string;firm:string;date:string;currency:'USD';balance:number|null;totalProfit:number|null;sessionPnl:number|null;minimumBalance:number|null;profitTarget:number|null;daysTraded:number|null;source:string;savedAt:string;flex?:FlexCheckpoint};
function text(v:unknown,max:number){if(typeof v!=='string'||!v.trim()||v.length>max||/[\u0000-\u001f]/.test(v))throw new Error('Enter the firm, account and source.');return v.trim();}
function value(v:unknown,nonnegative=false){if(v===null||v===undefined||v==='')return null;if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1e9||(nonnegative&&v<0))throw new Error('Invalid firm-reported amount.');return Math.round(v*100)/100;}
export function validateFirmReference(input:Record<string,unknown>,savedAt=new Date().toISOString()):FirmReference{
 const account=text(input.account,150);if(/^(Sim|Playback)/i.test(account))throw new Error('Firm references must identify a prop account.');
 const date=text(input.date,10);if(!/^20\d\d-\d\d-\d\d$/.test(date)||!Number.isFinite(Date.parse(date+'T12:00:00Z'))||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)throw new Error('Enter the date of the firm figures.');
 const daysTraded=value(input.daysTraded,true);if(daysTraded!==null&&(!Number.isSafeInteger(daysTraded)||daysTraded>10000))throw new Error('Trading days must be a non-negative whole number.');
 if(input.currency!=='USD')throw new Error('This firm reference uses USD.');
 const reference:FirmReference={account,firm:text(input.firm,80),date,currency:'USD',balance:value(input.balance,true),totalProfit:value(input.totalProfit),sessionPnl:value(input.sessionPnl),minimumBalance:value(input.minimumBalance,true),profitTarget:value(input.profitTarget,true),daysTraded,source:text(input.source,300),savedAt};
 if(input.flex!==undefined){
  const f=input.flex as FlexCheckpoint;
  if(!f||!/^LF[EF]050\d+$/i.test(account)||!['Evaluation','Funded'].includes(f.stage))throw new Error('Choose a recognized Lucid Flex 50K account stage.');
  if(f.consistencyPercent!==null&&f.consistencyPercent!==40&&f.consistencyPercent!==50)throw new Error('Flex consistency must be 40% or 50%.');
  if(f.qualifyingDays!==null&&(!Number.isSafeInteger(f.qualifyingDays)||f.qualifyingDays<0||f.qualifyingDays>5))throw new Error('Enter 0 to 5 qualifying profit days.');
  if(f.stage==='Evaluation'&&f.qualifyingDays!==null)throw new Error('Payout profit days apply to funded accounts.');
  if(f.stage==='Funded'&&f.consistencyPercent!==null)throw new Error('Funded Flex accounts have no consistency requirement.');
  if(typeof f.capturedAt!=='string'||!/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(f.capturedAt)||!Number.isFinite(Date.parse(f.capturedAt))||new Date(f.capturedAt).toISOString().slice(0,19)!==f.capturedAt.slice(0,19)||Date.parse(f.capturedAt)>Date.parse(savedAt)+120000)throw new Error('Enter a valid firm checkpoint time.');
  reference.flex={stage:f.stage,consistencyPercent:f.consistencyPercent,qualifyingDays:f.qualifyingDays,capturedAt:new Date(f.capturedAt).toISOString()};
  if(f.coveredPayoutIds!==undefined){if(!Array.isArray(f.coveredPayoutIds)||f.coveredPayoutIds.length>100||f.coveredPayoutIds.some(id=>typeof id!=='string'||!id||id.length>150))throw new Error('Invalid checkpoint payout references.');reference.flex.coveredPayoutIds=[...new Set(f.coveredPayoutIds)];}
 }
 if([reference.balance,reference.totalProfit,reference.sessionPnl,reference.minimumBalance,reference.profitTarget,daysTraded,reference.flex?.qualifyingDays??null,reference.flex?.consistencyPercent??null].every(v=>v===null))throw new Error('Enter at least one reported figure.');
 return reference;
}
