import type { Trade } from './types';

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
const hourFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', hourCycle: 'h23' });
export const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export function centralDay(time: string) {
  const p=Object.fromEntries(dayFormat.formatToParts(new Date(time)).map(v=>[v.type,v.value]));
  return p.year+'-'+p.month+'-'+p.day;
}
export function centralHour(time: string) { return Number(hourFormat.format(new Date(time))); }
export function addDays(day: string, n: number) { return new Date(Date.parse(day + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
export function duration(t: Trade) { return Math.max(0, (Date.parse(t.exit) - Date.parse(t.entry)) / 1000); }
export function ordered(trades: Trade[]) { return [...trades].sort((a,b) => a.exit.localeCompare(b.exit) || a.exitOrder-b.exitOrder || a.id.localeCompare(b.id)); }
export function summarize(trades: Trade[]) {
  const sorted = ordered(trades); let gross = 0, peak = 0, drawdown = 0, wins = 0, losses = 0, gain = 0, loss = 0;
  for (const t of sorted) { gross=round(gross+t.pnl); peak=Math.max(peak,gross); drawdown=Math.max(drawdown,peak-gross); if(t.pnl>0){wins++;gain+=t.pnl;} if(t.pnl<0){losses++;loss+=t.pnl;} }
  return {count:trades.length,gross,peak:round(peak),giveback:round(peak-gross),drawdown:round(drawdown),wins,losses,scratches:trades.length-wins-losses,
    winRate:trades.length?wins/trades.length:0,avg:trades.length?gross/trades.length:0,pf:loss<0?gain/Math.abs(loss):null,
    avgWin:wins?gain/wins:0,avgLoss:losses?loss/losses:0,activeDays:new Set(trades.map(t=>centralDay(t.exit))).size,
    last5:round(sorted.slice(-5).reduce((s,t)=>s+t.pnl,0))};
}
export function dailySeries(trades: Trade[]) {
  const grouped = new Map<string,{day:string,pnl:number,count:number,wins:number}>();
  for(const t of trades){const day=centralDay(t.exit);const d=grouped.get(day)||{day,pnl:0,count:0,wins:0};d.pnl=round(d.pnl+t.pnl);d.count++;d.wins+=Number(t.pnl>0);grouped.set(day,d);}
  let total=0,peak=0;
  return [...grouped.values()].sort((a,b)=>a.day.localeCompare(b.day)).map(d=>{total=round(total+d.pnl);peak=Math.max(peak,total);return {...d,cumulative:total,giveback:round(peak-total)};});
}
export function accountTradeGroups(trades: Trade[]) {
  const groups=new Map<string,Trade[]>();for(const t of trades){if(!groups.has(t.account))groups.set(t.account,[]);groups.get(t.account)!.push(t);}return groups;
}
export function bucketStats(trades: Trade[], key: (t:Trade)=>string) {
  const groups=new Map<string,Trade[]>();for(const t of trades){const k=key(t);if(!groups.has(k))groups.set(k,[]);groups.get(k)!.push(t);}
  return [...groups].map(([name,ts])=>({name,...summarize(ts)}));
}
export function afterResult(trades: Trade[]) {
  const groups=accountTradeGroups(trades), buckets:Record<string,Trade[]>={'First trade':[],'After a win':[],'After a loss':[],'After scratch':[]};
  for(const ts of groups.values()){
    const entries=[...ts].sort((a,b)=>a.entry.localeCompare(b.entry)||a.id.localeCompare(b.id));
    for(let i=0;i<entries.length;i++){
      const t=entries[i];const prior=entries.slice(0,i).filter(p=>centralDay(p.exit)===centralDay(t.entry)&&p.exit<=t.entry).sort((a,b)=>b.exit.localeCompare(a.exit)||b.exitOrder-a.exitOrder)[0];
      const k=!prior?'First trade':prior.pnl>0?'After a win':prior.pnl<0?'After a loss':'After scratch';buckets[k].push(t);
    }
  }
  return Object.entries(buckets).map(([name,ts])=>({name,...summarize(ts)}));
}
