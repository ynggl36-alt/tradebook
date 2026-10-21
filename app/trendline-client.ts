'use client';
import {readPriceBars} from '../lib/recorder-browser';
import {mergePriceBars,PRICE_RANGE_LIMIT} from '../lib/price-history';
import type {PriceBar} from '../lib/recorder';
import type {TrendJob,TrendJobResult} from '../lib/trendline-runner';
import {waitForTrendWorker} from '../lib/trendline-task';
export async function loadTrendPrices(contract:string,start:number,end:number,signal:AbortSignal):Promise<{bars:PriceBar[];warning:string}>{
  const cloud:PriceBar[]=[];let warning='';
  for(let from=start;from<=end;from+=PRICE_RANGE_LIMIT){
    const to=Math.min(end,from+PRICE_RANGE_LIMIT-60000),params=new URLSearchParams({contract,start:String(from),end:String(to)});
    const controller=new AbortController(),cancel=()=>controller.abort();signal.addEventListener('abort',cancel,{once:true});const timeout=setTimeout(cancel,30000);
    try{if(signal.aborted)throw new Error('Cancelled');const response=await fetch('/api/prices?'+params,{cache:'no-store',signal:controller.signal}),data=await response.json() as {bars:PriceBar[];error?:string};if(!response.ok||!Array.isArray(data.bars))throw new Error(data.error||'Price archive could not load.');cloud.push(...data.bars);}
    catch(error){if(signal.aborted)throw error;warning='Some cloud candles could not load; results use the available device and cloud history.';}
    finally{clearTimeout(timeout);signal.removeEventListener('abort',cancel);}
  }
  let local:PriceBar[]=[];try{local=await readPriceBars(contract,start,end);}catch{warning=warning||'Device candles could not load; results use the cloud archive.';}
  return {bars:mergePriceBars(cloud,local),warning};
}
export function calculateTrends(job:TrendJob,signal:AbortSignal,progress:(checked:number,total:number)=>void=()=>{}):Promise<TrendJobResult>{
  if(signal.aborted)return Promise.reject(new Error('Cancelled'));
  let worker:Worker;
  try{worker=new Worker(new URL('./trendline-worker.ts',import.meta.url),{type:'module'});}catch{return Promise.reject(new Error('Background analysis could not start. Refresh the page to retry.'));}
  return waitForTrendWorker(worker,job,signal,progress);
}
