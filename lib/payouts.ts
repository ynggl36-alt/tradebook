import type {CashRecord} from './types';
export const LUCID_TRADER_SPLIT=.9;
export const LUCID_SPLIT_URL='https://support.lucidtrading.com/en/articles/12945796-lucidflex-payouts';
export function payoutProceeds(record:CashRecord):{gross:number|null;expected:number|null;actual:number|null;split:number|null;basis:'confirmed-receipt'|'gross-request'|'trader-share'|'unknown'}{
 if(record.kind!=='payout')return {gross:null,expected:null,actual:null,split:null,basis:'unknown'};
 const lucid=/^LFF050\d+$/i.test(record.account),split=record.payoutSplit??(lucid?LUCID_TRADER_SPLIT:null),basis=record.payoutAmountBasis??(lucid?'gross-request':'unknown');
 const amount=record.firmPayout?.amount??null,gross=record.deduction??(basis==='gross-request'?amount:null);
 const expected=record.received??(basis==='trader-share'?amount:gross!==null&&split!==null?Math.round(Math.round(gross*100)*split)/100:null);
 return {gross,expected,actual:record.received,split,basis:record.received!==null?'confirmed-receipt':basis};
}
export function payoutIncomeSummary(rows:CashRecord[]){
 const payouts=rows.filter(r=>r.kind==='payout'),values=payouts.map(payoutProceeds),sum=(numbers:number[])=>numbers.reduce((s,n)=>s+Math.round(n*100),0)/100;
 return {count:payouts.length,gross:values.some(v=>v.gross!==null)?sum(values.flatMap(v=>v.gross===null?[]:[v.gross])):null,expected:values.length&&values.every(v=>v.expected!==null)?sum(values.map(v=>v.expected!)):null,actual:values.some(v=>v.actual!==null)?sum(values.flatMap(v=>v.actual===null?[]:[v.actual])):null,estimatedCount:values.filter(v=>v.actual===null&&v.expected!==null).length};
}
export type FirmPayout=NonNullable<CashRecord['firmPayout']>;
function text(value:unknown,max:number){if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f]/.test(value))throw new Error('Missing or invalid payout information.');return value.trim();}
function date(value:unknown){const d=text(value,10);if(!/^20\d\d-\d\d-\d\d$/.test(d)||!Number.isFinite(Date.parse(d+'T12:00:00Z'))||new Date(d+'T12:00:00Z').toISOString().slice(0,10)!==d)throw new Error('Invalid payout date.');return d;}
export function validateFirmPayout(input:unknown):FirmPayout{
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Missing firm payout confirmation.');
 const f=input as Record<string,unknown>,requestedDate=date(f.requestedDate),approvedDate=date(f.approvedDate);
 if(approvedDate<requestedDate)throw new Error('Payout approval cannot precede its request.');
 if(f.status!=='Paid'||f.currency!=='USD')throw new Error('This payout confirmation requires Paid status and USD.');
 if(typeof f.amount!=='number'||!Number.isFinite(f.amount)||f.amount<=0||f.amount>100000000||Math.abs(f.amount*100-Math.round(f.amount*100))>.00001)throw new Error('Enter the exact firm-reported payout amount.');
 return {firm:text(f.firm,80),currency:'USD',amount:Math.round(f.amount*100)/100,requestedDate,approvedDate,status:'Paid',source:text(f.source,300)};
}
export function payoutSummary(rows:CashRecord[]){
 const payouts=rows.filter(r=>r.kind==='payout'),firm=payouts.filter(r=>r.firmPayout?.status==='Paid'),received=payouts.filter(r=>r.received!==null),deductions=payouts.filter(r=>r.deduction!==null);
 const sum=(values:number[])=>values.reduce((s,v)=>s+Math.round(v*100),0)/100;
 return {firmCount:firm.length,firmAccounts:new Set(firm.map(r=>r.account)).size,firmAmount:firm.length?sum(firm.map(r=>r.firmPayout!.amount)):null,receivedCount:received.length,received:received.length?sum(received.map(r=>r.received!)):null,deductions:deductions.length?sum(deductions.map(r=>r.deduction!)):null,awaitingBank:firm.filter(r=>r.received===null).length};
}
export function planFirmPayoutImport(input:unknown,existing:CashRecord[]){
 if(!Array.isArray(input)||!input.length||input.length>200)throw new Error('Import 1 to 200 firm payout confirmations at a time.');
 const records:CashRecord[]=[],seen=[...existing];let duplicates=0;
 for(const raw of input){
  if(!raw||typeof raw!=='object')throw new Error('Invalid payout row.');
  const account=text(raw.account,64);if(!/^[A-Za-z0-9_-]+$/.test(account)||/^(Sim|Playback)/i.test(account))throw new Error('Choose a prop account for each payout.');
  const firmPayout=validateFirmPayout(raw.firmPayout),id='firm-paid-'+account+'-'+firmPayout.requestedDate;
  const same=seen.find(r=>r.id===id||(r.account===account&&r.firmPayout?.firm===firmPayout.firm&&r.firmPayout.requestedDate===firmPayout.requestedDate));
  if(same){
   const f=same.firmPayout;
   if(same.kind!=='payout'||same.account!==account||!f||f.firm!==firmPayout.firm||f.currency!==firmPayout.currency||f.amount!==firmPayout.amount||f.requestedDate!==firmPayout.requestedDate||f.approvedDate!==firmPayout.approvedDate||f.status!==firmPayout.status)throw new Error('This payout differs from a saved confirmation. Review it before replacing any figures.');
   duplicates++;continue;
  }
  const record:CashRecord={id,kind:'payout',account,date:firmPayout.approvedDate,deduction:null,received:null,expense:null,note:firmPayout.firm+' payout history',firmPayout};
  records.push(record);seen.push(record);
 }
 return {records,duplicates};
}
