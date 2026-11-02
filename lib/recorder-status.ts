import {monitorFresh} from './account-state';
import type {AccountMonitor,AccountState} from './account-state';

export type RecorderPhase='loading'|'disconnected'|'watching'|'permission'|'snapshot'|'unsupported';
export type AccountSyncStatus='permission'|'loading'|'paused'|'error'|'syncing'|'fresh'|'disconnected'|'waiting'|'stale'|'no-accounts'|'missing-balances'|'partial-balances';

// Browser access describes the current connection; a saved monitor only describes
// the recorder at its capture time. An old stopped snapshot is not a live signal.
export function accountSyncStatus(state:{phase:RecorderPhase;syncEnabled:boolean;syncing:boolean;hasError:boolean;monitor:AccountMonitor|null;accounts?:readonly AccountState[]},now=Date.now()):AccountSyncStatus{
 if(state.phase==='permission')return 'permission';
 if(state.phase==='loading')return 'loading';
 if(!state.syncEnabled)return 'paused';
 if(state.hasError)return 'error';
 if(state.syncing)return 'syncing';
 if(monitorFresh(state.monitor,now)){
  if(state.accounts){
   const current=state.accounts.filter(account=>account.connected&&account.capturedAt===state.monitor!.capturedAt&&state.monitor!.accountsSeen.includes(account.account));
   if(!current.length)return 'no-accounts';
   const supplied=current.filter(account=>account.values.CashValue?.at===account.capturedAt).length;
   if(!supplied)return 'missing-balances';
   if(supplied<current.length)return 'partial-balances';
  }
  return 'fresh';
 }
 if(state.phase!=='watching')return 'disconnected';
 return state.monitor?'stale':'waiting';
}

export function recorderUpdateAvailable(version:string){
 const current=version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)?.slice(1).map(Number),latest=[0,5,1];
 if(!current)return false;
 for(let i=0;i<latest.length;i++)if(current[i]!==latest[i])return current[i]<latest[i];
 return false;
}
