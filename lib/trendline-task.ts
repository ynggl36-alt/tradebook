import type {TrendJob,TrendJobResult,TrendWorkerMessage} from './trendline-runner';
export function waitForTrendWorker(worker:Worker,job:TrendJob,signal:AbortSignal,progress:(checked:number,total:number)=>void=()=>{}):Promise<TrendJobResult>{
  return new Promise((resolve,reject)=>{
    let settled=false;
    const stop=()=>{settled=true;worker.terminate();worker.onmessage=null;worker.onerror=null;signal.removeEventListener('abort',cancel);},cancel=()=>{stop();reject(new Error('Cancelled'));};
    if(signal.aborted){cancel();return;}
    signal.addEventListener('abort',cancel,{once:true});
    worker.onmessage=(event:MessageEvent<TrendWorkerMessage>)=>{
      const message=event.data;if(settled||message.id!==job.id||signal.aborted)return;
      if(message.error){stop();reject(new Error(message.error));}else if(message.result){stop();resolve(message.result);}else progress(message.progress??0,message.total??job.entries.length);
    };
    worker.onerror=()=>{stop();reject(new Error('Background analysis stopped. Refresh the analysis to retry.'));};
    try{worker.postMessage(job);}catch{stop();reject(new Error('The saved history could not be sent to background analysis.'));}
  });
}
