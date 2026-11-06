import { addDays, centralDay } from './analytics';
import { flexSession } from './trading-session';
import type { Journal } from './types';

export const REPORTING_YEAR = 2026;
export function yearBounds(year = REPORTING_YEAR) {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}
export function inYear(time: string, year = REPORTING_YEAR) {
  return !!time && centralDay(time).startsWith(`${year}-`);
}

// Scope reports without deleting source fills needed to reconstruct positions.
// Calendar's futures sessions can begin in the previous civil year.
export function journalForYear(source: Journal, year = REPORTING_YEAR, basis:'calendar'|'session'='calendar'): Journal {
  const includesTime=(time:string)=>basis==='session'?!!time&&flexSession(time).startsWith(`${year}-`):inYear(time,year);
  const trades = source.trades.filter(t => includesTime(t.exit));
  const cash = source.cash.filter(r => r.date.startsWith(`${year}-`));
  const realizedSessions=source.realizedSessions?.filter(row=>row.day.startsWith(`${year}-`));
  const sessionAccounts=basis==='session'?new Set(realizedSessions?.map(row=>row.account)):null;
  const tradeIds = new Set(trades.map(t => t.id));
  const cashAccounts = new Set(cash.map(r => r.account).filter(Boolean));
  const tradeTimes = new Map<string, string[]>();
  for (const t of trades) {
    const times = tradeTimes.get(t.account) || [];
    if (includesTime(t.entry)) times.push(t.entry);
    times.push(t.exit);
    tradeTimes.set(t.account, times);
  }
  const accounts = source.accounts.flatMap(a => {
    const issues = a.issues.filter(i => includesTime(i.time));
    const times = [a.first, a.last, ...issues.map(i => i.time), ...(tradeTimes.get(a.account) || [])]
      .filter(includesTime).sort((a, b) => Date.parse(a) - Date.parse(b));
    if (!times.length && !cashAccounts.has(a.account) && !sessionAccounts?.has(a.account)) return [];
    return [{ ...a, issues, first: times[0] || '', last: times.at(-1) || '' }];
  });
  const accountIds = new Set(accounts.map(a => a.account));
  return { ...source, trades, cash, accounts,realized:source.realized?.filter(row=>row.day.startsWith(`${year}-`)),realizedSessions,adjustments:source.adjustments?.filter(row=>row.date.startsWith(`${year}-`)),firmAdjustments:source.firmAdjustments?.filter(row=>row.date.startsWith(`${year}-`)),
    notes: source.notes.filter(n => tradeIds.has(n.id)),
    profiles: source.profiles.filter(p => accountIds.has(p.account)) };
}

export function reportingRange(period: string, through: string, year = REPORTING_YEAR) {
  const bounds = yearBounds(year);
  const end = through < bounds.start ? bounds.start : through > bounds.end ? bounds.end : through;
  const requested = period === 'all' ? bounds.start : addDays(end, 1 - Number(period));
  return { start: requested < bounds.start ? bounds.start : requested, end };
}
