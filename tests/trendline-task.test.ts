import {test} from 'node:test';
import assert from 'node:assert/strict';
import {waitForTrendWorker} from '../lib/trendline-task';
import type {TrendJobResult,TrendWorkerMessage} from '../lib/trendline-runner';
class FakeWorker{
  onmessage:((event:MessageEvent<TrendWorkerMessage>)=>void)|null=null;onerror:(()=>void)|null=null;stopped=0;sent=0;
  terminate(){this.stopped++;}postMessage(){this.sent++;}
  emit(message:TrendWorkerMessage){this.onmessage?.(new MessageEvent<TrendWorkerMessage>('message',{data:message}));}
}
const result={rows:[],snapshots:0,families:0,reactions:{complete:0,incomplete:0,baselineIneligible:0,bodyOnly:0,wickOnly:0,both:0,neither:0,impulse:{complete:0,bodyOnly:0,wickOnly:0,both:0,neither:0}}} satisfies TrendJobResult;
test('worker transport rejects stale job responses and releases handlers on completion',async()=>{
  const worker=new FakeWorker(),controller=new AbortController();let progress=0;
  const pending=waitForTrendWorker(worker as unknown as Worker,{id:'new',entries:[],prices:[]},controller.signal,n=>progress=n);
  worker.emit({id:'old',result});worker.emit({id:'old',progress:99});assert.equal(progress,0);assert.equal(worker.stopped,0);
  worker.emit({id:'new',progress:3});assert.equal(progress,3);worker.emit({id:'new',result});assert.equal(await pending,result);assert.equal(worker.stopped,1);assert.equal(worker.onmessage,null);
});
test('cancelling a replaced analysis terminates its worker and cannot commit a late result',async()=>{
  const worker=new FakeWorker(),controller=new AbortController();let progress=0;
  const pending=waitForTrendWorker(worker as unknown as Worker,{id:'cancel',entries:[],prices:[]},controller.signal,n=>progress=n);
  const delayed=worker.onmessage!;controller.abort();await assert.rejects(pending,/Cancelled/);delayed(new MessageEvent<TrendWorkerMessage>('message',{data:{id:'cancel',result}}));
  assert.equal(worker.stopped,1);assert.equal(progress,0);assert.equal(worker.onmessage,null);
  const aborted=new FakeWorker();await assert.rejects(waitForTrendWorker(aborted as unknown as Worker,{id:'never',entries:[],prices:[]},controller.signal),/Cancelled/);assert.equal(aborted.sent,0);
});
