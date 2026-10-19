import {normalizeContract} from './csv';
import type {Fill, Trade} from './types';
import {journalAccount} from './recorder-sync';
import type {AccountFill} from './recorder-sync';

/** Browser-local recorder context. Simulator fills never enter the real-account journal. */
export type PriceBar = {
  id: string; contract: string; start: number; end: number;
  open: number; high: number; low: number; close: number; volume: number;
  capturedAt: number;
};
export type CaptureRows = {
  root: Record<string,string>;
  bars: Record<string,string>[];
  executions: Record<string,string>[];
  issueCount: number;
};
export type RecorderCapture = {
  day: string; savedAt: number; version: string; mode: 'Sim101Only'|'AccountsReadOnly';
  warnings: number; simulatorFills: number; contracts: string[]; bars: PriceBar[];
  simulation: Fill[];
  accountFills:AccountFill[];
};
export type ExecutionMarker = {
  id: string; time: number; price: number; qty: number;
  side: 'Buy'|'Sell'; role: 'Entry'|'Exit';
};

export const RECORDER_FILE_LIMIT = 25 * 1024 * 1024;
export const isRecorderFile = (name: string) => /^\d{4}-\d{2}-\d{2}(?:\.accounts)?\.tradebook\.xml$/.test(name);
export const newestPriceBar = (previous:PriceBar|undefined,incoming:PriceBar) => !previous || previous.capturedAt<=incoming.capturedAt ? incoming : previous;

function utc(raw: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(raw || ''))
    throw new Error(label + ' must include an explicit UTC timestamp.');
  const value = Date.parse(raw);
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0,19) !== raw.slice(0,19))
    throw new Error('Invalid ' + label + '.');
  return value;
}
function number(raw: string, label: string) {
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw || '')) throw new Error('Invalid ' + label + '.');
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error('Invalid ' + label + '.');
  return value;
}
export function validateCapture(rows: CaptureRows, filename?: string): RecorderCapture {
  const root = rows.root;
  if (root.schemaVersion !== '1' || !['Sim101Only','AccountsReadOnly'].includes(root.mode))
    throw new Error('Unknown capture formats were not loaded. Use the Tradebook simulator or read-only account recorder.');
  const live=root.mode==='AccountsReadOnly';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(root.day || '') || !Number.isFinite(Date.parse(root.day+'T12:00:00Z')) ||
      new Date(root.day + 'T12:00:00Z').toISOString().slice(0,10) !== root.day)
    throw new Error('The capture date is invalid.');
  if (filename && filename !== root.day + (live?'.accounts':'') + '.tradebook.xml') throw new Error('The file name, account mode and capture date differ.');
  if (root.dayTimeZone !== 'America/Chicago') throw new Error('The recorder day must use Central time.');
  const savedAt = utc(root.savedAtUtc, 'capture save time');
  const warningCount = number(root.warningCountThisRun, 'warning count');
  if (!Number.isSafeInteger(warningCount) || warningCount < 0) throw new Error('Invalid warning count.');
  if (rows.bars.length > 50000 || rows.executions.length > 50000) throw new Error('This daily capture is too large.');
  const executionIds=new Set<string>();
  const executions=rows.executions.map(fill => {
    // A capture claiming to be simulator-only must never silently contain another account.
    if (!live&&fill.Account !== 'Sim101') throw new Error('An unexpected account was found in a simulator-only capture.');
    if (live&&!journalAccount(fill.Account||''))throw new Error('Simulator or invalid accounts are excluded from account captures.');
    const key=JSON.stringify([fill.Account,fill.ID]);
    if (!fill.ID || fill.ID.length>150 || executionIds.has(key)) throw new Error('An execution ID is missing or duplicated.');
    executionIds.add(key);
    const contract=normalizeContract(fill.Instrument || '');
    if (!['MNQ','NQ','ES','MES'].includes(contract.symbol)) throw new Error('Unexpected simulator instrument.');
    const side=/^(Buy|BuyToCover)$/.test(fill.Action)?'Buy':/^(Sell|SellShort)$/.test(fill.Action)?'Sell':null;
    if (!side) throw new Error('Unrecognized simulator execution action.');
    const qty=number(fill.Quantity,'simulator quantity'),price=number(fill.Price,'simulator price'),ordinal=number(fill.Sequence,'execution sequence');
    if (!Number.isSafeInteger(qty) || qty<=0 || price<=0 || !Number.isSafeInteger(ordinal) || ordinal<=0) throw new Error('Invalid simulator execution quantity, price or sequence.');
    const at=utc(fill.Time,'execution time');if(at>savedAt)throw new Error('A simulator execution is later than its capture.');
    const pos=number(fill.RawAccountPosition,'reported simulator position');
    if(!Number.isSafeInteger(pos))throw new Error('Invalid reported simulator position.');
    return {account:fill.Account,id:fill.ID,...contract,side,qty,price,time:new Date(at).toISOString(),ordinal,pos} as AccountFill;
  }).sort((a,b)=>a.time.localeCompare(b.time)||a.ordinal-b.ordinal);
  const unique = new Map<string,PriceBar>();
  for (const raw of rows.bars) {
    const {contract,symbol} = normalizeContract(raw.Instrument || '');
    if (!['MNQ','NQ','ES','MES'].includes(symbol)) throw new Error('Unexpected recorder instrument.');
    if (raw.IntervalSeconds !== '60' || raw.TimestampConvention !== 'end-of-bar' ||
        raw.MergePolicy !== 'DoNotMerge' || raw.TradingHours !== 'Default 24 x 7')
      throw new Error('Unsupported candle interval, session or contract-merge policy.');
    const end = utc(raw.BarEndUtc, 'candle end time');
    if (end % 60000 || end > savedAt) throw new Error('A candle is unfinished or not aligned to a minute.');
    const open = number(raw.Open,'open'), high = number(raw.High,'high'), low = number(raw.Low,'low'), close = number(raw.Close,'close'), volume = number(raw.Volume,'volume');
    if (Math.min(open,high,low,close) <= 0 || high < Math.max(open,close) || low > Math.min(open,close) || low > high || volume < 0 || !Number.isSafeInteger(volume))
      throw new Error('A candle has inconsistent prices or volume.');
    const start = end - 60000, id = contract + '|' + start;
    if (unique.has(id)) throw new Error('Duplicate candles were found in one capture.');
    unique.set(id,{id,contract,start,end,open,high,low,close,volume,capturedAt:savedAt});
  }
  const bars = [...unique.values()].sort((a,b) => a.start - b.start || a.contract.localeCompare(b.contract));
  return {day:root.day,savedAt,version:root.recorderVersion || 'unknown',mode:root.mode as RecorderCapture['mode'],warnings:Math.max(warningCount,rows.issueCount),simulatorFills:live?0:executions.length,contracts:[...new Set(bars.map(b=>b.contract))].sort(),bars,simulation:live?[]:executions,accountFills:live?executions:[]};
}

export function aggregateBars(input: PriceBar[], minutes: number): PriceBar[] {
  if (![1,5,15].includes(minutes)) throw new Error('Unsupported chart interval.');
  const size = minutes * 60000;
  const buckets = new Map<string,PriceBar>();
  for (const bar of [...input].sort((a,b)=>a.start-b.start)) {
    const start = Math.floor(bar.start / size) * size, id = bar.contract + '|' + start;
    const previous = buckets.get(id);
    // Do not invent missing minutes. The bar covers only observed constituent candles.
    if (previous) {previous.high=Math.max(previous.high,bar.high);previous.low=Math.min(previous.low,bar.low);previous.close=bar.close;previous.volume+=bar.volume;previous.end=Math.max(previous.end,bar.end);}
    else buckets.set(id,{...bar,id,start,end:bar.end});
  }
  return [...buckets.values()].sort((a,b)=>a.start-b.start);
}
export function executionMarkers(trade: Trade, fills: Fill[]): ExecutionMarker[] {
  const byId = new Map(fills.map(f=>[f.id,f]));
  return (trade.parts || []).flatMap((part,index)=>{
    const fill=byId.get(part[0]);
    if (!fill || (part[3] !== 'Buy' && part[3] !== 'Sell')) return [];
    const side=part[3], role=(trade.dir==='Long' ? side==='Buy' : side==='Sell')?'Entry':'Exit';
    return [{id:part[0]+':'+index,time:Date.parse(fill.time),price:part[2],qty:part[1],side,role} as ExecutionMarker];
  }).sort((a,b)=>a.time-b.time);
}
export function markerCoverage(markers: ExecutionMarker[], bars: PriceBar[]) {
  const byMinute = new Map(bars.map(b=>[b.start,b]));
  let covered=0, outside=0;
  for (const marker of markers) {
    const bar=byMinute.get(Math.floor(marker.time/60000)*60000);
    if (bar) {covered++;if(marker.price<bar.low-1e-7 || marker.price>bar.high+1e-7) outside++;}
  }
  return {total:markers.length,covered,missing:markers.length-covered,outside};
}
