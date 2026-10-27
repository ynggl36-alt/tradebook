export const ACCOUNT_STATE_FILE='account-state.tradebook.xml';
export const ACCOUNT_STATE_LIMIT=1024*1024;
export const ACCOUNT_FIELDS=['CashValue','NetLiquidation','RealizedProfitLoss','UnrealizedProfitLoss']as const;
export type AccountField=typeof ACCOUNT_FIELDS[number];
export type AccountValue={value:number;at:string;source:'PlatformRead'|'AccountItemUpdate'};
export type OpenPosition={instrument:string;side:'Long'|'Short';quantity:number;averagePrice:number};
export type AccountState={account:string;currency:string;connected:boolean;connection:string;provider:string;values:Partial<Record<AccountField,AccountValue>>;positions:OpenPosition[];positionsAvailable:boolean;positionsAt:string|null;capturedAt:string};
export type AccountStateCapture={schemaVersion:1;mode:'AccountsReadOnly';recorderVersion:string;capturedAt:string;running:boolean;scopePrefixes:string[];accounts:AccountState[]};
export type AccountMonitor={capturedAt:string;running:boolean;recorderVersion:string;scopePrefixes:string[];accountsSeen:string[]};
export type AccountStateData={monitor:AccountMonitor|null;accounts:AccountState[]};
export const EMPTY_ACCOUNT_STATE:AccountStateData={monitor:null,accounts:[]};
// Captures are full snapshots, not patches. A missing item is unavailable;
// neither an old value nor an assumed zero belongs to the new capture. Also
// normalize legacy rows whose values/positions were merged across captures.
// Source observations remain untouched for historical accounting.
export function currentAccountSnapshot(account:AccountState):AccountState{
 const values:AccountState['values']={};
 if(account.connected)for(const field of ACCOUNT_FIELDS){const value=account.values[field];if(value?.at===account.capturedAt)values[field]=value;}
 const positionsAvailable=account.connected&&account.positionsAvailable&&account.positionsAt===account.capturedAt;
 return {...account,values,positionsAvailable,positions:positionsAvailable?account.positions:[],positionsAt:positionsAvailable?account.capturedAt:null};
}
export function currentAccountSnapshots(data:AccountStateData):AccountStateData{return {...data,accounts:data.accounts.map(currentAccountSnapshot)};}
// A late account upload can change a previously seen account without changing
// the global heartbeat. Compare the complete normalized response, not just it.
export function refreshAccountSnapshots(previous:AccountStateData,incoming:AccountStateData):AccountStateData{
 const next=currentAccountSnapshots(incoming);
 return JSON.stringify(previous)===JSON.stringify(next)?previous:next;
}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid account snapshot.');return value as Record<string,unknown>;}
function text(value:unknown,max:number,blank=false){if(typeof value!=='string'||value.length>max||(!blank&&!value.trim())||/[\u0000-\u001f]/.test(value))throw new Error('Invalid account snapshot text.');return value.trim();}
function stamp(value:unknown,label:string){const v=text(value,50);if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,19)!==v.slice(0,19))throw new Error('Invalid '+label+'.');return new Date(v).toISOString();}
function bool(value:unknown){if(typeof value!=='boolean')throw new Error('Invalid account snapshot flag.');return value;}
function amount(value:unknown){if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e12)throw new Error('Invalid reported account value.');return value;}
export function validateAccountState(input:unknown,now=Date.now()):AccountStateCapture{
 const root=object(input);
 if(root.schemaVersion!==1||root.mode!=='AccountsReadOnly')throw new Error('Use the read-only account recorder for account snapshots.');
 const capturedAt=stamp(root.capturedAt,'account capture time');if(Date.parse(capturedAt)>now+120000)throw new Error('The recorder clock is ahead. Check the Windows clock.');
 const recorderVersion=text(root.recorderVersion,30),running=bool(root.running);
 if(!Array.isArray(root.scopePrefixes)||root.scopePrefixes.length<1||root.scopePrefixes.length>10)throw new Error('Missing account scope.');
 const scopePrefixes=root.scopePrefixes.map(p=>{const s=text(p,30);if(!/^[A-Za-z0-9_-]+$/.test(s))throw new Error('Invalid account prefix.');return s;});
 if(!Array.isArray(root.accounts)||root.accounts.length>1000)throw new Error('Too many accounts in one snapshot.');
 const names=new Set<string>();
 const accounts=root.accounts.map(raw=>{
  const r=object(raw),account=text(r.account,150);
  if(/^(Sim|Playback)/i.test(account)||!scopePrefixes.some(p=>account.toLowerCase().startsWith(p.toLowerCase()))||names.has(account))throw new Error('Simulator, duplicate or out-of-scope accounts cannot enter the account monitor.');names.add(account);
  const currency=text(r.currency,30);if(!/^[A-Za-z]{3,30}$/.test(currency))throw new Error('Invalid account currency.');
  const connected=bool(r.connected),positionsAvailable=bool(r.positionsAvailable),values:AccountState['values']={};
  for(const [field,rawValue]of Object.entries(object(r.values))){
   if(!ACCOUNT_FIELDS.includes(field as AccountField))throw new Error('Unknown account value.');
   const v=object(rawValue),at=stamp(v.at,'account value time');if(at>capturedAt)throw new Error('Account value is later than its capture.');
   if(v.source!=='PlatformRead'&&v.source!=='AccountItemUpdate')throw new Error('Missing account value source.');
   values[field as AccountField]={value:amount(v.value),at,source:v.source};
  }
  if(!Array.isArray(r.positions)||r.positions.length>100)throw new Error('Invalid open positions.');
  const instruments=new Set<string>();
  const positions=r.positions.map(rawPosition=>{const p=object(rawPosition),instrument=text(p.instrument,80);if(instruments.has(instrument))throw new Error('Duplicate open position.');instruments.add(instrument);
   if(p.side!=='Long'&&p.side!=='Short')throw new Error('Invalid position side.');
   if(typeof p.quantity!=='number'||!Number.isSafeInteger(p.quantity)||p.quantity<=0||p.quantity>100000)throw new Error('Invalid position quantity.');
   return {instrument,side:p.side,quantity:p.quantity,averagePrice:amount(p.averagePrice)}as OpenPosition;
  });
  if(!positionsAvailable&&positions.length)throw new Error('Unavailable positions must not be reported as current.');
  if(!connected&&(Object.keys(values).length||positionsAvailable))throw new Error('Disconnected accounts cannot report current values.');
  return {account,currency,connected,connection:text(r.connection,150,true),provider:text(r.provider,80,true),values,positions,positionsAvailable,positionsAt:positionsAvailable?capturedAt:null,capturedAt};
 });
 return {schemaVersion:1,mode:'AccountsReadOnly',recorderVersion,capturedAt,running,scopePrefixes,accounts};
}
export function monitorFresh(monitor:AccountMonitor|null,now=Date.now()){
 if(!monitor||!monitor.running)return false;const age=now-Date.parse(monitor.capturedAt),[major,minor]=monitor.recorderVersion.split('.').map(Number);
 const maxAge=major>0||(major===0&&minor>=4)?180000:90000;
 return age>=-120000&&age<=maxAge;
}
export function accountAvailability(account:AccountState,monitor:AccountMonitor|null,now=Date.now()):'connected'|'disconnected'|'not-seen'|'last-known'{
 if(!monitor||account.capturedAt!==monitor.capturedAt||!monitor.accountsSeen.includes(account.account))return 'not-seen';
 if(!monitorFresh(monitor,now))return 'last-known';return account.connected?'connected':'disconnected';
}
