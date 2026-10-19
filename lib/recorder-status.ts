import {monitorFresh} from './account-state';
import type {AccountMonitor} from './account-state';

export type RecorderPhase='loading'|'disconnected'|'watching'|'permission'|'snapshot'|'unsupported';
export type AccountSyncStatus='permission'|'loading'|'paused'|'error'|'syncing'|'fresh'|'disconnected'|'waiting'|'stale';

// Browser access describes the current connection; a saved monitor only describes
// the recorder at its capture time. An old stopped snapshot is not a live signal.
export function accountSyncStatus(state:{phase:RecorderPhase;syncEnabled:boolean;syncing:boolean;hasError:boolean;monitor:AccountMonitor|null},now=Date.now()):AccountSyncStatus{
 if(state.phase==='permission')return 'permission';
 if(state.phase==='loading')return 'loading';
 if(!state.syncEnabled)return 'paused';
 if(state.hasError)return 'error';
 if(state.syncing)return 'syncing';
 if(monitorFresh(state.monitor,now))return 'fresh';
 if(state.phase!=='watching')return 'disconnected';
 return state.monitor?'stale':'waiting';
}
