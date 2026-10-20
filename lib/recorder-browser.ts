import {RECORDER_FILE_LIMIT, isRecorderFile, newestPriceBar, validateCapture} from './recorder';
import type {PriceBar, RecorderCapture} from './recorder';
import {buildSimulatorHistory} from './simulator';
import type {SimulatorSnapshot} from './simulator';
import {accountExecutionKey,executionFingerprint,pendingAccountFills} from './recorder-sync';
import type {AccountFill,AccountSnapshot,SyncReceipt,SyncResult} from './recorder-sync';
import {PRICE_BATCH_SIZE,priceFingerprint,priceValuesFingerprint} from './price-history';

export type RecorderDirectory = {
  kind: 'directory'; name: string;
  values(): AsyncIterable<RecorderFileHandle | {kind:'directory';name:string}>;
  getFileHandle?:(name:string)=>Promise<RecorderFileHandle>;
  queryPermission(options: {mode:'read'}): Promise<PermissionState>;
  requestPermission(options: {mode:'read'}): Promise<PermissionState>;
};
export type RecorderFileHandle = {kind:'file';name:string;getFile():Promise<File>};
export type RecorderFileInfo = {
  name:string;lastModified:number;size:number;day:string;savedAt:number;version:string;
  contracts:string[];barCount:number;simulatorFills:number;warnings:number;simulationVersion?:number;
  mode?:RecorderCapture['mode'];accountFills?:number;captureVersion?:number;
};
export type RecorderSummary = {files:RecorderFileInfo[];barCount:number};
export type DirectoryPickerWindow = Window & {showDirectoryPicker?:(options:{id:string;mode:'read'})=>Promise<RecorderDirectory>};
export const needsCaptureRead=(file:Pick<File,'name'|'size'|'lastModified'>,known?:RecorderFileInfo)=>!known||known.captureVersion!==2||file.size!==known.size||file.lastModified!==known.lastModified;

export function parseRecorderXml(xml: string, filename?: string): RecorderCapture {
  if (xml.length > RECORDER_FILE_LIMIT) throw new Error('Choose a capture under 25 MB.');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML declarations with external entities are not supported.');
  const doc = new DOMParser().parseFromString(xml,'application/xml');
  if (doc.querySelector('parsererror') || doc.documentElement?.tagName !== 'TradebookCapture')
    throw new Error('This is not a complete Tradebook capture XML file. It will be retried on the next check.');
  const attrs = (el:Element) => Object.fromEntries([...el.attributes].map(a=>[a.name,a.value]));
  const root=doc.documentElement;
  const records=[...root.children].filter(e=>e.tagName==='Records');
  if (records.length!==1) throw new Error('The capture must have one Records section.');
  const children=[...records[0].children];
  if (children.some(e=>!['MinuteBar','Execution'].includes(e.tagName))) throw new Error('Unknown recorder records were not loaded.');
  return validateCapture({root:attrs(root),bars:children.filter(e=>e.tagName==='MinuteBar').map(attrs),executions:children.filter(e=>e.tagName==='Execution').map(attrs),issueCount:root.querySelector('Issues')?.children.length || 0},filename);
}

let opening:Promise<IDBDatabase>|undefined;
function database() {
  if (!opening) opening=new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open('tradebook-recorder-local',4);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains('settings'))db.createObjectStore('settings');
      if(!db.objectStoreNames.contains('files'))db.createObjectStore('files',{keyPath:'name'});
      if(!db.objectStoreNames.contains('bars')){const bars=db.createObjectStore('bars',{keyPath:'id'});bars.createIndex('contractTime',['contract','start']);}
      if(!db.objectStoreNames.contains('simulation'))db.createObjectStore('simulation',{keyPath:'name'});
      if(!db.objectStoreNames.contains('accountCaptures'))db.createObjectStore('accountCaptures',{keyPath:'name'});
      if(!db.objectStoreNames.contains('syncReceipts'))db.createObjectStore('syncReceipts',{keyPath:'key'});
      if(!db.objectStoreNames.contains('priceUploads')){const queue=db.createObjectStore('priceUploads',{keyPath:'id'});queue.createIndex('time','start');}
    };
    request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();opening=undefined;};resolve(request.result);};
    request.onerror=()=>{opening=undefined;reject(request.error || new Error('Local storage could not open.'));};
    request.onblocked=()=>{opening=undefined;reject(new Error('Close other Tradebook tabs and try again.'));};
  });
  return opening;
}
async function setting<T>(key:string):Promise<T|undefined> {
  const db=await database();return new Promise((resolve,reject)=>{const request=db.transaction('settings').objectStore('settings').get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
}
export const restoreDirectory=()=>setting<RecorderDirectory>('directory');
export const restoreExecutionSync=async()=>await setting<boolean>('executionSyncEnabled')!==false;
export async function rememberExecutionSync(enabled:boolean){const db=await database();await new Promise<void>((resolve,reject)=>{const tx=db.transaction('settings','readwrite');tx.objectStore('settings').put(enabled,'executionSyncEnabled');tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
export async function rememberDirectory(handle:RecorderDirectory) {
  const db=await database();await new Promise<void>((resolve,reject)=>{const tx=db.transaction('settings','readwrite');tx.objectStore('settings').put(handle,'directory');tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
}
export async function forgetDirectory() {
  const db=await database();await new Promise<void>((resolve,reject)=>{const tx=db.transaction('settings','readwrite');tx.objectStore('settings').delete('directory');tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
}
export async function clearPriceCache() {
  const db=await database();await new Promise<void>((resolve,reject)=>{const tx=db.transaction(['bars','files'],'readwrite');tx.objectStore('bars').clear();tx.objectStore('files').clear();tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
}
export async function readRecorderSummary():Promise<RecorderSummary> {
  const db=await database();return new Promise((resolve,reject)=>{
    const tx=db.transaction(['files','bars']);let files:RecorderFileInfo[]=[],barCount=0;
    const f=tx.objectStore('files').getAll();f.onsuccess=()=>{files=f.result;};
    const b=tx.objectStore('bars').count();b.onsuccess=()=>{barCount=b.result;};
    tx.oncomplete=()=>resolve({files:files.sort((a,b)=>b.day.localeCompare(a.day)),barCount});tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
}
export async function readPriceBars(contract:string,start:number,end:number):Promise<PriceBar[]> {
  const db=await database();return new Promise((resolve,reject)=>{
    const range=IDBKeyRange.bound([contract,start],[contract,end]);
    const request=db.transaction('bars').objectStore('bars').index('contractTime').getAll(range);
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
}
export async function readSimulatorHistory(){
  const db=await database();
  const snapshots=await new Promise<SimulatorSnapshot[]>((resolve,reject)=>{const request=db.transaction('simulation').objectStore('simulation').getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  return buildSimulatorHistory(snapshots);
}
export type LastExecutionSync=SyncResult&{at:number};
export async function readAccountSyncState(){
  const db=await database();const state=await new Promise<{snapshots:AccountSnapshot[];receipts:SyncReceipt[];last:LastExecutionSync|null}>((resolve,reject)=>{
    const tx=db.transaction(['accountCaptures','syncReceipts','settings']);let snapshots:AccountSnapshot[]=[],receipts:SyncReceipt[]=[],last:LastExecutionSync|null=null;
    const a=tx.objectStore('accountCaptures').getAll();a.onsuccess=()=>{snapshots=a.result;};const r=tx.objectStore('syncReceipts').getAll();r.onsuccess=()=>{receipts=r.result;};const s=tx.objectStore('settings').get('lastExecutionSync');s.onsuccess=()=>{last=s.result||null;};
    tx.oncomplete=()=>resolve({snapshots,receipts,last});tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
  const all=pendingAccountFills(state.snapshots,[]),pending=pendingAccountFills(state.snapshots,state.receipts);
  return {pending,retained:all.length,accounts:[...new Set(all.map(f=>f.account))].sort(),last:state.last};
}
export async function acknowledgeAccountFills(fills:AccountFill[],result:SyncResult){
  const db=await database();await new Promise<void>((resolve,reject)=>{const tx=db.transaction(['syncReceipts','settings'],'readwrite');for(const fill of fills)tx.objectStore('syncReceipts').put({key:accountExecutionKey(fill),fingerprint:executionFingerprint(fill)} satisfies SyncReceipt);tx.objectStore('settings').put({...result,at:Date.now()} satisfies LastExecutionSync,'lastExecutionSync');tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
}
export async function cacheCapture(file: Pick<File,'name'|'size'|'lastModified'>, capture:RecorderCapture) {
  const db=await database();const info:RecorderFileInfo={name:file.name,size:file.size,lastModified:file.lastModified,day:capture.day,savedAt:capture.savedAt,version:capture.version,contracts:capture.contracts,barCount:capture.bars.length,simulatorFills:capture.simulatorFills,warnings:capture.warnings,simulationVersion:1,captureVersion:2,mode:capture.mode,accountFills:capture.accountFills.length};
  await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction(['bars','files','simulation','accountCaptures','priceUploads'],'readwrite'), bars=tx.objectStore('bars');
    for (const incoming of capture.bars) {
      let bar=incoming;
      const old=bars.get(incoming.id);
      old.onsuccess=()=>{if(!incoming.observed&&old.result&&priceValuesFingerprint(old.result)===priceValuesFingerprint(incoming))bar={...incoming,capturedAt:old.result.capturedAt};if(newestPriceBar(old.result,bar)===bar){bars.put(bar);if(bar.start>=Date.UTC(2026,0,1)&&(!old.result||priceFingerprint(old.result)!==priceFingerprint(bar)))tx.objectStore('priceUploads').put(bar);}};
    }
    const previous=tx.objectStore('files').get(file.name);
    previous.onsuccess=()=>{tx.objectStore('files').put(!previous.result||previous.result.savedAt<=info.savedAt?info:{...previous.result,lastModified:info.lastModified,size:info.size,simulationVersion:1,captureVersion:2});};
    const store=tx.objectStore(capture.mode==='Sim101Only'?'simulation':'accountCaptures'),old=store.get(file.name);
    old.onsuccess=()=>{if(!old.result||old.result.savedAt<=capture.savedAt)store.put({name:file.name,savedAt:capture.savedAt,fills:capture.mode==='Sim101Only'?capture.simulation:capture.accountFills});};
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
}

// Upgrade existing device-only candles gradually. Cursor progress and queued bars
// commit together; closing the tab cannot skip a portion of the old cache.
export async function seedPriceUploads(){
  const db=await database();
  await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction(['bars','priceUploads','settings'],'readwrite'),settings=tx.objectStore('settings');
    const progress=settings.get('priceQueueCursor');
    progress.onsuccess=()=>{
      if(progress.result===true)return;
      const range=typeof progress.result==='string'?IDBKeyRange.lowerBound(progress.result,true):undefined;
      const request=tx.objectStore('bars').openCursor(range);let count=0;
      request.onsuccess=()=>{const cursor=request.result;if(!cursor){settings.put(true,'priceQueueCursor');return;}
        const bar=cursor.value as PriceBar;
        if(bar.start>=Date.UTC(2026,0,1)){const pending=tx.objectStore('priceUploads').get(bar.id);pending.onsuccess=()=>{if(!pending.result||pending.result.capturedAt<=bar.capturedAt)tx.objectStore('priceUploads').put(bar);};}
        settings.put(cursor.key,'priceQueueCursor');if(++count<1000)cursor.continue();
      };
    };
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
}
export type PriceUploadState={pending:number;at:number};
export async function readPriceUploadState():Promise<PriceUploadState>{
  const db=await database();return new Promise((resolve,reject)=>{
    const tx=db.transaction(['priceUploads','settings']);let pending=0,at=0;
    const count=tx.objectStore('priceUploads').count();count.onsuccess=()=>{pending=count.result;};
    const last=tx.objectStore('settings').get('lastPriceUpload');last.onsuccess=()=>{at=last.result||0;};
    tx.oncomplete=()=>resolve({pending,at});tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
}
export async function nextPriceUpload():Promise<PriceBar[]>{
  const db=await database();return new Promise((resolve,reject)=>{
    const tx=db.transaction('priceUploads'),request=tx.objectStore('priceUploads').index('time').openCursor(null,'prev'),bars:PriceBar[]=[];
    request.onsuccess=()=>{const cursor=request.result;if(cursor){bars.push(cursor.value);if(bars.length<PRICE_BATCH_SIZE)cursor.continue();}};
    tx.oncomplete=()=>resolve(bars);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
}
export async function acknowledgePriceUpload(bars:PriceBar[]){
  const db=await database();await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction(['priceUploads','settings'],'readwrite'),queue=tx.objectStore('priceUploads');
    for(const bar of bars){const current=queue.get(bar.id);current.onsuccess=()=>{if(current.result&&priceFingerprint(current.result)===priceFingerprint(bar))queue.delete(bar.id);};}
    tx.objectStore('settings').put(Date.now(),'lastPriceUpload');
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
}

export async function readCaptureFile(file:File) {
  if (!isRecorderFile(file.name)) throw new Error('Choose a YYYY-MM-DD.tradebook.xml capture.');
  if (file.size>RECORDER_FILE_LIMIT) throw new Error(file.name+' is over 25 MB.');
  const capture=parseRecorderXml(await file.text(),file.name);
  await cacheCapture(file,capture);
  return capture;
}
