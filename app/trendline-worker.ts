import {runTrendJob} from '../lib/trendline-runner';
import type {TrendJob,TrendWorkerMessage} from '../lib/trendline-runner';
const scope=self as unknown as {onmessage:((event:MessageEvent<TrendJob>)=>void)|null;postMessage:(message:TrendWorkerMessage)=>void};
scope.onmessage=event=>{const job=event.data;void runTrendJob(job,(progress,total)=>scope.postMessage({id:job.id,progress,total})).then(result=>scope.postMessage({id:job.id,result})).catch(error=>scope.postMessage({id:job.id,error:error instanceof Error?error.message:String(error)}));};
