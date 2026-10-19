import type {Fill} from './types';

export type AccountFill=Fill&{account:string};
export type AccountSnapshot={name:string;savedAt:number;fills:AccountFill[]};
export type SyncReceipt={key:string;fingerprint:string};
export const accountExecutionKey=(fill:AccountFill)=>JSON.stringify([fill.account,fill.id]);
export const journalAccount=(name:string)=>!!name&&name.length<=150&&!/^(sim|playback)/i.test(name);
export const executionFingerprint=(fill:AccountFill)=>JSON.stringify([fill.account,fill.id,fill.contract,fill.side,fill.qty,fill.price,Date.parse(fill.time),fill.pos,fill.entryFlag??null]);

export function pendingAccountFills(snapshots:AccountSnapshot[],receipts:SyncReceipt[]){
  const accepted=new Map(receipts.map(r=>[r.key,r.fingerprint])),unique=new Map<string,AccountFill>();
  for(const snapshot of snapshots)for(const fill of snapshot.fills){
    if(!journalAccount(fill.account))throw new Error('Simulator accounts cannot enter automatic journal imports.');
    const key=accountExecutionKey(fill),old=unique.get(key);
    if(old&&executionFingerprint(old)!==executionFingerprint(fill))throw new Error('Conflicting recorder executions for '+fill.account+'. Check the source captures before syncing.');
    unique.set(key,fill);
  }
  return [...unique.values()].filter(f=>accepted.get(accountExecutionKey(f))!==executionFingerprint(f)).sort((a,b)=>a.time.localeCompare(b.time)||a.ordinal-b.ordinal||a.account.localeCompare(b.account));
}
export function executionBatches(fills:AccountFill[]){
  const batches:AccountFill[][]=[];let batch:AccountFill[]=[],accounts=new Set<string>();
  for(const fill of fills){if(batch.length>=500||(!accounts.has(fill.account)&&accounts.size>=20)){batches.push(batch);batch=[];accounts=new Set();}batch.push(fill);accounts.add(fill.account);}if(batch.length)batches.push(batch);return batches;
}
export function validateRecorderImport(input:Record<string,unknown>){
  if(input.mode!=='AccountsReadOnly'||!Array.isArray(input.fills)||!input.fills.length||input.fills.some(f=>!f||typeof f.account!=='string'||!journalAccount(f.account)))
    throw new Error('Automatic imports require an account recorder capture and exclude simulator accounts.');
}
export type SyncResult={added:number;duplicates:number;sent:number};
export async function synchronizeExecutions(fills:AccountFill[],post:(payload:Record<string,unknown>)=>Promise<{added:number;duplicates:number}>,acknowledge:(batch:AccountFill[],result:SyncResult)=>Promise<void>,enabled:()=>boolean){
  const result:SyncResult={added:0,duplicates:0,sent:0};
  for(const batch of executionBatches(fills)){
    if(!enabled())break;
    if(batch.some(f=>!journalAccount(f.account)))throw new Error('Simulator executions were excluded from automatic sync.');
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(batch.map(executionFingerprint))));
    const checksum=Array.from(new Uint8Array(bytes)).map(x=>x.toString(16).padStart(2,'0')).join('');
    const response=await post({mode:'AccountsReadOnly',source:'NinjaTrader recorder',checksum,chunk:0,fills:batch});
    if(!Number.isInteger(response.added)||!Number.isInteger(response.duplicates)||response.added<0||response.duplicates<0||response.added+response.duplicates!==batch.length)
      throw new Error('The server did not confirm every execution. This batch remains pending for a safe retry.');
    result.added+=response.added;result.duplicates+=response.duplicates;result.sent+=batch.length;
    await acknowledge(batch,{...result});
  }
  return result;
}
