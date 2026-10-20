'use client';
import React,{createContext,useCallback,useContext,useEffect,useMemo,useRef,useState} from 'react';
import {Activity,ArrowRight,CheckCircle2,ExternalLink,FolderOpen,LoaderCircle,RefreshCw,Unplug,Upload} from 'lucide-react';
import {acknowledgeAccountFills,acknowledgePriceUpload,forgetDirectory,needsCaptureRead,nextPriceUpload,readAccountSyncState,readCaptureFile,readPriceUploadState,readRecorderSummary,readSimulatorHistory,rememberDirectory,rememberExecutionSync,restoreDirectory,restoreExecutionSync,seedPriceUploads} from '../lib/recorder-browser';
import type {DirectoryPickerWindow,LastExecutionSync,RecorderDirectory,RecorderFileInfo,RecorderSummary} from '../lib/recorder-browser';
import type {AccountHistory} from '../lib/types';
import {isRecorderFile} from '../lib/recorder';
import {dateLabel,num,timeLabel} from './ui';
import {centralDay} from '../lib/analytics';
import {synchronizeExecutions} from '../lib/recorder-sync';
import {ACCOUNT_STATE_FILE,ACCOUNT_STATE_LIMIT,EMPTY_ACCOUNT_STATE,monitorFresh} from '../lib/account-state';
import type {AccountStateCapture,AccountStateData} from '../lib/account-state';
import {parseAccountStateXml} from '../lib/account-state-browser';
import {accountSyncStatus} from '../lib/recorder-status';
import type {RecorderPhase} from '../lib/recorder-status';
import {recorderEntries,RECORDER_SCAN_MS,RECORDER_BACKGROUND_SCAN_MS,RECORDER_DISCOVERY_MS} from '../lib/recorder-schedule';

type Phase=RecorderPhase;
type SyncInfo={pending:number;retained:number;accounts:string[];last:LastExecutionSync|null};
type RecorderState={
  phase:Phase;folder:string;busy:boolean;error:string;notice:string;checkedAt:number;
  summary:RecorderSummary;revision:number;supported:boolean;simulation:AccountHistory|null;simulationError:string;
  connect:()=>Promise<void>;resume:()=>Promise<void>;scan:(force?:boolean)=>Promise<boolean>;disconnect:()=>Promise<void>;
  snapshots:(files:File[])=>Promise<void>;
  syncEnabled:boolean;syncing:boolean;syncError:string;syncInfo:SyncInfo;activeAccounts:boolean;
  accountState:AccountStateData;accountStateError:string;accountStateLoading:boolean;
  refreshAccountState:()=>Promise<boolean>;syncAccounts:(force?:boolean)=>Promise<void>;setExecutionSync:(enabled:boolean)=>Promise<void>;
  priceSync:{pending:number;at:number;uploading:boolean;error:string};priceRevision:number;
};
const RecorderContext=createContext<RecorderState|null>(null);
const CloudRevisionContext=createContext(0);
export const useCloudJournalRevision=()=>useContext(CloudRevisionContext);
export function useRecorder(){const value=useContext(RecorderContext);if(!value)throw new Error('Recorder provider is missing.');return value;}
const message=(e:unknown)=>e instanceof Error?e.message:String(e);
const permissionError=(e:unknown)=>e instanceof DOMException&&['NotAllowedError','SecurityError'].includes(e.name);
async function postRecorderExecutions(payload:Record<string,unknown>){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),25000);
  try{const response=await fetch('/api/recorder-import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});const data=await response.json() as {error?:string;added:number;duplicates:number};if(!response.ok)throw new Error(data?.error||'Execution sync failed.');return data;}
  catch(e){if(e instanceof DOMException&&e.name==='AbortError')throw new Error('Execution sync timed out. Saved files remain pending and will retry safely.');throw e;}finally{clearTimeout(timeout);}
}

export function RecorderProvider({children}:{children:React.ReactNode}){
  const [phase,setPhase]=useState<Phase>('loading'),[folder,setFolder]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[checkedAt,setCheckedAt]=useState(0),[revision,setRevision]=useState(0),[supported,setSupported]=useState(false);
  const [summary,setSummary]=useState<RecorderSummary>({files:[],barCount:0});
  const [simulation,setSimulation]=useState<AccountHistory|null>(null),[simulationError,setSimulationError]=useState('');
  const [syncEnabled,setSyncEnabled]=useState(true),[syncing,setSyncing]=useState(false),[syncError,setSyncError]=useState(''),[cloudRevision,setCloudRevision]=useState(0);
  const [syncInfo,setSyncInfo]=useState<SyncInfo>({pending:0,retained:0,accounts:[],last:null});
  const [priceSync,setPriceSync]=useState({pending:0,at:0,uploading:false,error:''}),[priceRevision,setPriceRevision]=useState(0);
  const priceWorking=useRef(false),priceRetry=useRef(0);
  const [activeAccounts,setActiveAccounts]=useState(false);
  const [accountState,setAccountState]=useState<AccountStateData>(EMPTY_ACCOUNT_STATE),[accountLoadError,setAccountLoadError]=useState(''),[accountUploadError,setAccountUploadError]=useState(''),[accountStateLoading,setAccountStateLoading]=useState(true);
  const accountStateError=[accountUploadError,accountLoadError].filter(Boolean).join(' ');
  const fileErrors=useRef(new Map<string,string>()),lastSyncOk=useRef(true);
  const nextDiscovery=useRef(0),nextScan=useRef(0),executionRevision=useRef(0),readExecutionRevision=useRef(-1),pendingCount=useRef(0);
  const accountSnapshot=useRef<AccountStateCapture|null>(null),accountFile=useRef<{modified:number;size:number}|null>(null),accountAcknowledged=useRef(''),accountRequest=useRef(0),stateRetryAfter=useRef(0);
  const refreshAccountState=useCallback(async()=>{
    const request=++accountRequest.current,controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
    try{const response=await fetch('/api/account-state',{cache:'no-store',signal:controller.signal}),data=await response.json() as AccountStateData&{error?:string};if(!response.ok)throw new Error(data.error||'Account information could not load.');
      if(alive.current&&request===accountRequest.current){setAccountState(previous=>previous.monitor&&data.monitor&&previous.monitor.capturedAt===data.monitor.capturedAt?previous:data);setAccountLoadError('');setAccountStateLoading(false);}return true;
    }catch(e){if(alive.current&&request===accountRequest.current){setAccountLoadError(message(e));setAccountStateLoading(false);}return false;}finally{clearTimeout(timeout);}
  },[]);
  const syncAllowed=useRef<boolean|null>(null),syncWorking=useRef(false),retryAfter=useRef(0);
  const directory=useRef<RecorderDirectory|null>(null),working=useRef(false),generation=useRef(0),alive=useRef(false),known=useRef(new Map<string,RecorderFileInfo>());
  const updateSummary=useCallback(async()=>{
    const [next,sim]=await Promise.all([readRecorderSummary(),readSimulatorHistory().then(history=>({history,error:''}),e=>({history:null,error:message(e)}))]);
    if(alive.current){known.current=new Map(next.files.map(f=>[f.name,f]));setSummary(next);setSimulation(sim.history);setSimulationError(sim.error);}return next;
  },[]);
  const syncAccounts=useCallback(async(force=false)=>{
    if(syncWorking.current||(!directory.current&&!force))return;
    syncWorking.current=true;lastSyncOk.current=true;const run=generation.current,captured=accountSnapshot.current;let imported=false,previousAdded=0;
    const uploadAccountSnapshot=async()=>{
      if(syncAllowed.current===true&&captured&&captured.capturedAt>accountAcknowledged.current&&(force||Date.now()>=stateRetryAfter.current)){
        if(alive.current)setSyncing(true);
        const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),25000);
        try{
          const response=await fetch('/api/account-state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(captured),signal:controller.signal}),result=await response.json() as {error?:string;capturedAt?:string;accepted?:boolean};
          if(!response.ok)throw new Error(result.error||'Account snapshot sync failed.');
          if(typeof result.capturedAt!=='string'||result.capturedAt<captured.capturedAt)throw new Error('The account snapshot was not confirmed. It will retry.');
          accountAcknowledged.current=captured.capturedAt;stateRetryAfter.current=0;if(alive.current)setAccountUploadError('');await refreshAccountState();
        }catch(e){lastSyncOk.current=false;stateRetryAfter.current=Date.now()+60000;if(alive.current)setAccountUploadError('Balance sync: '+message(e));}finally{clearTimeout(timeout);}
      }
    };
    try{
      if(!alive.current||run!==generation.current)return;
      // Heartbeat-only checks do not need to reload every cached capture and receipt.
      if(!force&&readExecutionRevision.current===executionRevision.current&&(pendingCount.current===0||syncAllowed.current!==true))return;
      const readingRevision=executionRevision.current;
      const state=await readAccountSyncState();
      readExecutionRevision.current=readingRevision;pendingCount.current=state.pending.length;if(!alive.current||run!==generation.current)return;if(alive.current)setSyncInfo({...state,pending:state.pending.length});
      if(syncAllowed.current!==true||!state.pending.length||(!force&&Date.now()<retryAfter.current))return;
      if(alive.current)setSyncing(true);
      await synchronizeExecutions(state.pending,postRecorderExecutions,async(batch,result)=>{
        if(result.added>previousAdded)imported=true;previousAdded=result.added;
        await acknowledgeAccountFills(batch,result);
      },()=>alive.current&&run===generation.current&&syncAllowed.current===true);
      const next=await readAccountSyncState();pendingCount.current=next.pending.length;if(alive.current){setSyncInfo({...next,pending:next.pending.length});setSyncError('');}retryAfter.current=0;
    }catch(e){lastSyncOk.current=false;retryAfter.current=Date.now()+60000;if(alive.current)setSyncError(message(e));}
    finally{if(lastSyncOk.current&&pendingCount.current===0&&alive.current&&run===generation.current)await uploadAccountSnapshot();syncWorking.current=false;if(alive.current){setSyncing(false);if(imported)setCloudRevision(n=>n+1);}}
  },[refreshAccountState]);
  const syncPrices=useCallback(async()=>{
    if(priceWorking.current||syncAllowed.current!==true||syncWorking.current||pendingCount.current>0||Date.now()<priceRetry.current)return;
    priceWorking.current=true;let uploaded=false;
    try{
      await seedPriceUploads();
      if(alive.current)setPriceSync(previous=>({...previous,uploading:true}));
      // Price backlog yields to executions and balances between small requests.
      for(let batch=0;batch<12&&alive.current&&syncAllowed.current===true&&!syncWorking.current&&pendingCount.current===0;batch++){
        const bars=await nextPriceUpload();if(!bars.length)break;
        const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
        try{
          const response=await fetch('/api/prices',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bars}),signal:controller.signal}),result=await response.json() as {confirmed?:number;error?:string};
          if(!response.ok||result.confirmed!==bars.length)throw new Error(result.error||'Price archive did not confirm this batch.');
          await acknowledgePriceUpload(bars);uploaded=true;
        }finally{clearTimeout(timeout);}
      }
      priceRetry.current=0;if(alive.current)setPriceSync(previous=>({...previous,error:''}));
    }catch(e){priceRetry.current=Date.now()+60000;if(alive.current)setPriceSync(previous=>({...previous,error:message(e)}));}
    finally{
      priceWorking.current=false;
      try{const state=await readPriceUploadState();if(alive.current){setPriceSync(previous=>({...previous,...state,uploading:false}));if(uploaded)setPriceRevision(n=>n+1);}}catch(e){if(alive.current)setPriceSync(previous=>({...previous,uploading:false,error:message(e)}));}
    }
  },[]);
  const scan=useCallback(async(force=false)=>{
    const handle=directory.current;if(!handle||working.current)return false;
    if(!force&&Date.now()<nextScan.current)return false;
    nextScan.current=Date.now()+(document.visibilityState==='visible'?RECORDER_SCAN_MS:RECORDER_BACKGROUND_SCAN_MS);
    working.current=true;setBusy(true);const run=generation.current;let changed=0,found=0,accountsFound=!!accountSnapshot.current||[...known.current.values()].some(f=>f.mode==='AccountsReadOnly');const errors=fileErrors.current,seen=new Set<string>();
    try{
      if(await handle.queryPermission({mode:'read'})!=='granted'){if(alive.current&&run===generation.current)setPhase('permission');return false;}
      const full=force||Date.now()>=nextDiscovery.current;
      for await(const entry of recorderEntries(handle,full)){
        if(!alive.current||run!==generation.current)return false;
        if(entry.kind!=='file')continue;
        seen.add(entry.name);
        if(entry.name===ACCOUNT_STATE_FILE){
          try{
            const file=await entry.getFile();if(file.size>ACCOUNT_STATE_LIMIT)throw new Error('Account snapshot is larger than 1 MB.');
            if(!accountFile.current||accountFile.current.modified!==file.lastModified||accountFile.current.size!==file.size){
              accountSnapshot.current=parseAccountStateXml(await file.text());accountFile.current={modified:file.lastModified,size:file.size};
            }
            accountsFound=true;found++;errors.delete(entry.name);
          }catch(e){if(permissionError(e))throw e;errors.set(entry.name,entry.name+': '+message(e));}
          continue;
        }
        if(!isRecorderFile(entry.name))continue;
        found++;
        try{
          const file=await entry.getFile();
          const previous=known.current.get(file.name);
          if(!needsCaptureRead(file,previous)){if(previous?.mode==='AccountsReadOnly')accountsFound=true;errors.delete(entry.name);continue;}
          const capture=await readCaptureFile(file);if(capture.mode==='AccountsReadOnly'){accountsFound=true;executionRevision.current++;}changed++;errors.delete(entry.name);
        }catch(e){if(permissionError(e))throw e;errors.set(entry.name,entry.name+': '+message(e));}
      }
      if(!alive.current||run!==generation.current)return false;
      if(full){nextDiscovery.current=Date.now()+RECORDER_DISCOVERY_MS;for(const name of errors.keys())if(!seen.has(name))errors.delete(name);}
      if(changed){await updateSummary();setRevision(r=>r+1);}
      setCheckedAt(Date.now());setPhase('watching');setActiveAccounts(accountsFound);setError([...errors.values()].slice(0,2).join(' '));
      setNotice(found||known.current.size?'':'No daily captures found. Choose the folder shown by the recorder’s “Copy saved-folder path” button (accounts-v2 for account recording).');
      await syncAccounts(force);void syncPrices();return errors.size===0&&lastSyncOk.current;
    }catch(e){if(alive.current&&run===generation.current){if(permissionError(e))setPhase('permission');setError(message(e));}return false;}
    finally{working.current=false;if(alive.current)setBusy(false);}
  },[updateSummary,syncAccounts,syncPrices]);
  useEffect(()=>{
    alive.current=true;let cancelled=false;
    const capable=typeof (window as DirectoryPickerWindow).showDirectoryPicker==='function';setSupported(capable);
    (async()=>{
      try{
        const [cached,handle,enabled,state]=await Promise.all([updateSummary(),restoreDirectory(),restoreExecutionSync(),readAccountSyncState()]);
        if(cancelled)return;
        syncAllowed.current=enabled;setSyncEnabled(enabled);pendingCount.current=state.pending.length;setSyncInfo({...state,pending:state.pending.length});
        if(handle&&capable){directory.current=handle;setFolder(handle.name);if(await handle.queryPermission({mode:'read'})==='granted'){if(!cancelled)await scan();}else if(!cancelled)setPhase('permission');}
        else setPhase(cached.barCount?'snapshot':capable?'disconnected':'unsupported');
      }catch(e){if(!cancelled){setPhase(capable?'disconnected':'unsupported');setError('Local recorder storage could not open. '+message(e));setSimulationError(message(e));}}
    })();
    const timer=setInterval(()=>{void scan();},RECORDER_SCAN_MS);
    const focus=()=>{if(document.visibilityState==='visible')void scan();};
    window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    return()=>{cancelled=true;alive.current=false;generation.current++;clearInterval(timer);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};
  },[scan,updateSummary]);
  useEffect(()=>{
    void refreshAccountState();let lastRead=Date.now();
    const check=()=>{const wait=document.visibilityState==='visible'?60000:120000;if(Date.now()-lastRead>=wait){lastRead=Date.now();void refreshAccountState();}};
    const timer=setInterval(check,30000);
    return()=>clearInterval(timer);
  },[refreshAccountState]);
  useEffect(()=>{void syncPrices();const timer=setInterval(()=>void syncPrices(),15000);return()=>clearInterval(timer);},[syncPrices]);
  const setExecutionSync=useCallback(async(enabled:boolean)=>{
    syncAllowed.current=enabled;setSyncEnabled(enabled);if(!enabled)setSyncError('');
    try{await rememberExecutionSync(enabled);if(enabled)await syncAccounts(true);}catch(e){setSyncError(message(e));}
  },[syncAccounts]);
  const connect=useCallback(async()=>{
    const picker=(window as DirectoryPickerWindow).showDirectoryPicker;if(!picker)return;
    // Call the picker directly in the click gesture, before any asynchronous storage work.
    try{
      const handle=await picker.call(window,{id:'tradebook-recorder',mode:'read'});
      generation.current++;directory.current=handle;fileErrors.current.clear();nextDiscovery.current=0;nextScan.current=0;executionRevision.current++;accountSnapshot.current=null;accountFile.current=null;setFolder(handle.name);setActiveAccounts(false);setError('');setNotice('');
      await rememberDirectory(handle);await scan(true);
    }catch(e){if(e instanceof DOMException&&e.name==='AbortError')return;setError(permissionError(e)?'Open Tradebook in its own Chrome or Edge tab, then connect the folder again. The browser needs your permission to read it.':message(e));}
  },[scan]);
  const resume=useCallback(async()=>{
    const handle=directory.current;if(!handle)return connect();
    try{if(await handle.requestPermission({mode:'read'})==='granted'){setError('');await scan(true);}else{setPhase('permission');setError('Folder access was not granted. Use “Choose another folder” to reconnect.');}}catch(e){setError(message(e));}
  },[connect,scan]);
  const disconnect=useCallback(async()=>{
    generation.current++;directory.current=null;fileErrors.current.clear();nextDiscovery.current=0;nextScan.current=0;executionRevision.current++;accountSnapshot.current=null;accountFile.current=null;setFolder('');setActiveAccounts(false);setError('');setNotice('');
    try{await forgetDirectory();setPhase(summary.barCount?'snapshot':supported?'disconnected':'unsupported');}catch(e){setError(message(e));}
  },[summary.barCount,supported]);
  const snapshots=useCallback(async(files:File[])=>{
    if(working.current)return;working.current=true;setBusy(true);setError('');setNotice('');let loaded=0;const errors:string[]=[];
    try{
      for(const file of files){try{if(file.name===ACCOUNT_STATE_FILE){if(file.size>ACCOUNT_STATE_LIMIT)throw new Error('Account snapshot is larger than 1 MB.');accountSnapshot.current=parseAccountStateXml(await file.text());}else await readCaptureFile(file);loaded++;}catch(e){errors.push(file.name+': '+message(e));}}
      if(loaded){await updateSummary();setRevision(r=>r+1);if(!directory.current)setPhase('snapshot');setNotice(num(loaded)+' capture'+(loaded===1?'':'s')+' loaded locally.');await syncAccounts(true);}
      setError(errors.slice(0,2).join(' '));
    }catch(e){setError(message(e));}finally{working.current=false;setBusy(false);}
  },[updateSummary,syncAccounts,syncPrices]);
  const value=useMemo(()=>({phase,folder,busy,error,notice,checkedAt,summary,revision,supported,simulation,simulationError,syncEnabled,syncing,syncError,syncInfo,activeAccounts,accountState,accountStateError,accountStateLoading,refreshAccountState,syncAccounts,setExecutionSync,connect,resume,scan,disconnect,snapshots,priceSync,priceRevision}),[phase,folder,busy,error,notice,checkedAt,summary,revision,supported,simulation,simulationError,syncEnabled,syncing,syncError,syncInfo,activeAccounts,accountState,accountStateError,accountStateLoading,refreshAccountState,syncAccounts,setExecutionSync,connect,resume,scan,disconnect,snapshots,priceSync,priceRevision]);
  return <RecorderContext.Provider value={value}><CloudRevisionContext.Provider value={cloudRevision}>{children}</CloudRevisionContext.Provider></RecorderContext.Provider>;
}

export function RecorderBadge({onClick}:{onClick:()=>void}){
  const r=useRecorder(),monitor=r.accountState.monitor,hasError=!!(r.error||r.syncError||r.accountStateError);
  const connected=r.phase==='watching'&&!hasError, fresh=monitorFresh(monitor);
  const status=accountSyncStatus({phase:r.phase,syncEnabled:r.syncEnabled,syncing:r.syncing,hasError,monitor});
  const text=status==='permission'?'Allow folder access':status==='loading'?'Checking connection…':status==='paused'?'Sync paused':status==='error'?'Check sync':status==='syncing'?'Saving journal…':status==='stale'?'Snapshot needs update':connected?r.activeAccounts?r.syncInfo.pending?'Executions pending':fresh?'Journal synced':'Folder connected':'Folder connected':r.summary.barCount?'Saved candles ready':'Connect recorder';
  return <button className={'recorder-badge '+(connected&&status==='fresh'?'connected':'')} onClick={onClick} title="Open sync settings"><Activity size={13}/>{text}</button>;
}
export function RecorderConnection({onSimulator}:{onSimulator?:()=>void}){
  const r=useRecorder(),input=useRef<HTMLInputElement>(null);
  const newest=Math.max(r.summary.files.reduce((time,f)=>Math.max(time,f.savedAt),0),Date.parse(r.accountState.monitor?.capturedAt||'')||0),oldestDay=r.summary.files.at(-1)?.day,lastDay=r.summary.files[0]?.day;
  const warnings=r.summary.files.reduce((n,f)=>n+f.warnings,0),simFills=r.summary.files.reduce((n,f)=>n+f.simulatorFills,0);
  const watching=r.phase==='watching'&&!r.error,permission=r.phase==='permission';
  return <section className="panel recorder-panel"><div className="recorder-intro"><div className="recorder-emblem"><FolderOpen size={25}/></div><div><div className="eyebrow">AUTOMATIC JOURNAL SYNC</div><h2>{watching?'Your recorder folder is connected':permission?'Allow the folder connection again':'Connect your recorder folder'}</h2><p>One connection brings in executions, account values and archived candle charts.</p></div><span className={'recorder-state '+(watching?'live':'')}>{r.busy?<LoaderCircle size={13} className="spin"/>:watching?<CheckCircle2 size={13}/>:<Activity size={13}/>} {r.busy?'Checking files…':watching?'Watching folder':permission?'Permission needed':r.phase==='snapshot'?'Snapshot loaded':'Setup once'}</span></div>
  <div className="recorder-overview"><div><strong>{r.folder||'Choose the folder copied from NinjaTrader'}</strong><p>{newest?'Latest saved data: '+dateLabel(centralDay(new Date(newest).toISOString()),true)+' · '+timeLabel(new Date(newest).toISOString())+' CT':'Waiting for your first recorder capture'}</p><small>{r.checkedAt?'Folder checked '+timeLabel(new Date(r.checkedAt).toISOString())+' CT':'Checks about every 30 seconds while active'}</small></div><div className="recorder-actions">{r.supported&&(!r.folder||permission)&&<button className="button primary small" disabled={r.busy||r.phase==='loading'} onClick={()=>void(permission?r.resume():r.connect())}><FolderOpen size={15}/>{permission?'Allow folder access':'Connect recorder folder'}</button>}</div></div>
  {!!r.accountState.monitor&&r.accountState.monitor.recorderVersion!=='0.5.0'&&<div className="notice"><strong>Recorder 0.5.0 is available</strong><p>Recorder 0.5.0 adds automatic chart-history catch-up after all monitored accounts are flat and idle for five minutes. Update the source once after trading; leave continuous candle collection off.</p><a className="text-button" href="/recorder/TradebookRecorder.cs?v=0.5.0" download>Download recorder 0.5.0 source <ArrowRight size={13}/></a></div>}
  <ExecutionSyncCard/>
  <div className="notice"><strong>Price archive</strong><p>{r.priceSync.uploading?'Saving recorded candles…':r.priceSync.pending?num(r.priceSync.pending)+' candles waiting to archive':r.priceSync.at?'Recorded candles confirmed '+timeLabel(new Date(r.priceSync.at).toISOString())+' CT':'Waiting for recorded candles'}. Saved prices follow your journal across browsers. {r.priceSync.error&&<span className="negative">{r.priceSync.error} Unsaved candles will retry automatically.</span>}</p></div>
  {r.error&&<div className="error-box" role="alert">{r.error}</div>}{r.notice&&<div className="notice" role="status">{r.notice}</div>}{warnings>0&&<div className="notice" role="status">{num(warnings)} recorder warnings are present. Check Issues in the source capture before relying on its context.</div>}
  <details className="recorder-tools"><summary>Folder setup & recovery <ArrowRight size={14}/></summary><div className="recorder-tool-body"><p>In NinjaTrader recorder 0.5.0, choose <b>Connected accounts</b>, start recording and click <b>Copy saved-folder path</b>. Connect its <b>accounts-v2</b> folder here in desktop Chrome. Your account prefixes control which accounts are recorded.</p><div className="recorder-actions">{r.supported&&<button className="button subtle small" disabled={r.busy||r.phase==='loading'} onClick={()=>void r.connect()}><FolderOpen size={14}/>{r.folder?'Choose another folder':'Choose recorder folder'}</button>}{r.folder&&<button className="text-button" disabled={r.busy} onClick={()=>void r.disconnect()}><Unplug size={13}/> Disconnect folder</button>}<a className="text-button" href="/recorder/TradebookRecorder.cs?v=0.5.0" download>Recorder source</a><a className="text-button" href="/recorder/START-HERE.md?v=0.5.0" download>Setup guide</a></div>
  <div className="recorder-recovery-tools"><strong>Manual recovery & simulator test</strong><p>Load an XML snapshot when folder access is unavailable. Simulator snapshots use the separate simulator-v1 folder and remain excluded from your prop-account results.</p><div className="recorder-actions"><button className="button subtle small" disabled={r.busy} onClick={()=>input.current?.click()}><Upload size={14}/> Load XML snapshot</button><input ref={input} type="file" accept=".xml" multiple hidden onChange={e=>{const files=Array.from(e.target.files||[]);e.target.value='';if(files.length)void r.snapshots(files);}}/>{onSimulator&&<button className="text-button" onClick={onSimulator}>Review Sim101 test trades <ArrowRight size={14}/></button>}{(!r.supported||permission)&&<a className="text-button" href="/" target="_blank" rel="noopener noreferrer">Open Tradebook in its own tab <ExternalLink size={12}/></a>}</div></div>
  {r.summary.barCount>0&&<div className="recorder-counts"><div><strong>{num(r.summary.barCount)}</strong><span>local candles</span></div><div><strong>{num(r.summary.files.length)}</strong><span>daily captures</span></div><div><strong>{oldestDay&&dateLabel(oldestDay,true)} – {lastDay&&dateLabel(lastDay,true)}</strong><span>price dates available</span></div><div><strong>{num(simFills)}</strong><span>Sim101 fills · excluded</span></div></div>}
  {!r.supported&&r.phase!=='loading'&&<p className="recorder-browser-hint">Folder reading needs desktop Chrome or Edge. You can still review saved journal data here or load a snapshot.</p>}</div></details>
  <div className="recorder-footnote"><p>Keep NinjaTrader’s recorder and Tradebook open for updates. If Chrome closes, saved executions catch up when you reopen it with folder access. Recorder 0.5.0 catches up prices while flat and idle. Available candles upload automatically and stay with the journal. Older archive files are discovered about every ten minutes; background timers can be delayed.</p><a className="text-button" href="/recorder/TradebookRecorder-0.5.0-source.zip" download>Download source and setup guide</a></div></section>;
}
function ExecutionSyncCard(){
  const r=useRecorder(),last=r.syncInfo.last,monitor=r.accountState.monitor,fresh=monitorFresh(monitor);
  const state=accountSyncStatus({phase:r.phase,syncEnabled:r.syncEnabled,syncing:r.syncing,hasError:!!(r.error||r.syncError||r.accountStateError),monitor});
  const status=state==='permission'?'Allow folder access':state==='loading'?'Checking connection…':state==='paused'?'Paused':state==='error'?'Needs attention':state==='syncing'?'Saving journal…':r.folder&&!r.activeAccounts?'Waiting for account recorder':!r.folder?'Snapshot · no folder connected':r.syncInfo.pending?'Executions waiting to sync':monitor&&!fresh?'Saved history · waiting for a fresh snapshot':last||monitor?'Up to date':'Waiting for executions';
  return <div className="execution-sync"><div className="execution-sync-header"><div><strong>Automatic journal sync</strong><p>{status}</p></div><button className={'sync-switch '+(r.syncEnabled?'enabled':'')} role="switch" aria-checked={r.syncEnabled} disabled={r.phase==='loading'} onClick={()=>void r.setExecutionSync(!r.syncEnabled)}><span/>{r.syncEnabled?'On':'Paused'}</button></div><div className="execution-sync-metrics"><div><strong>{num(r.syncInfo.retained)}</strong><span>account fills captured</span></div><div><strong>{num(r.syncInfo.accounts.length)}</strong><span>accounts captured</span></div><div><strong>{num(r.syncInfo.pending)}</strong><span>waiting for confirmation</span></div><div><strong>{last?timeLabel(new Date(last.at).toISOString())+' CT':r.accountState.monitor?timeLabel(r.accountState.monitor.capturedAt)+' CT':'No account sync yet'}</strong><span>{last?num(last.added)+' new · '+num(last.duplicates)+' duplicates in last sync':'Sim101 is never uploaded'}</span></div></div>{r.phase==='watching'&&r.folder&&!r.activeAccounts&&<p className="sync-setup-hint">No account capture has been found in this folder yet. Start <b>Connected accounts</b> in NinjaTrader and check that this is the <b>accounts-v2</b> folder.</p>}<div className="execution-sync-bottom"><p>New executions append to existing accounts. Repeated IDs are ignored; conflicting fills stop the affected import for review. New account IDs keep their own history.</p>{(r.syncInfo.pending>0||r.syncError||r.accountStateError)&&<span>Use Sync now above to retry.</span>}</div>{r.syncError&&<div className="error-box" role="alert">{r.syncError} Pending files remain on this computer.</div>}{r.accountStateError&&<div className="error-box" role="alert">{r.accountStateError}</div>}</div>;
}
