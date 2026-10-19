import {addDays,centralDay} from './analytics';
import {ACCOUNT_STATE_FILE} from './account-state';
import type {RecorderDirectory,RecorderFileHandle} from './recorder-browser';

export const RECORDER_SCAN_MS=30000;
export const RECORDER_BACKGROUND_SCAN_MS=60000;
export const RECORDER_DISCOVERY_MS=600000;
export function recentRecorderFiles(now=Date.now()){
 const today=centralDay(new Date(now).toISOString());
 return [ACCOUNT_STATE_FILE,...[today,addDays(today,-1)].flatMap(day=>[day+'.accounts.tradebook.xml',day+'.tradebook.xml'])];
}
export async function* recorderEntries(handle:RecorderDirectory,full:boolean,now=Date.now()):AsyncIterable<RecorderFileHandle|{kind:'directory';name:string}>{
 if(full||!handle.getFileHandle){yield* handle.values();return;}
 for(const name of recentRecorderFiles(now)){
  try{yield await handle.getFileHandle(name);}
  catch(e){if((e as {name?:string})?.name!=='NotFoundError')throw e;}
 }
}
