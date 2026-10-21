import type {PriceBar} from './recorder';
import {measureTrendEntry,observePairReaction,prepareTrends,scanTrends,summarizeReactions} from './trendlines';
import type {ReactionCheck,ReactionSummary,TrendEntry,TrendEntryResult,TrendSnapshot} from './trendlines';
export type TrendJob={id:string;entries:TrendEntry[];prices:PriceBar[];chart?:boolean};
export type TrendJobResult={rows:TrendEntryResult[];reactions:ReactionSummary;snapshots:number;families:number;chart?:TrendSnapshot};
export type TrendWorkerMessage={id:string;progress?:number;total?:number;result?:TrendJobResult;error?:string};
export async function runTrendJob(job:TrendJob,progress:(checked:number,total:number)=>void=()=>{}):Promise<TrendJobResult>{
  const contracts=[...new Set(job.entries.map(e=>e.contract))],prepared=new Map(contracts.map(c=>[c,prepareTrends(job.prices,c)]));
  const cache=new Map<string,TrendSnapshot>(),observations=new Map<string,ReactionCheck>(),rows:TrendEntryResult[]=[];
  let chart:TrendSnapshot|undefined;
  for(let i=0;i<job.entries.length;i++){
    const entry=job.entries[i],key=entry.contract+'|'+Math.floor(Date.parse(entry.entry)/60000),source=prepared.get(entry.contract)!;
    let snapshot=cache.get(key);
    if(!snapshot){
      const scan=scanTrends(source,Date.parse(entry.entry));snapshot=scan.snapshot;cache.set(key,snapshot);
      if(!job.chart)for(const pair of scan.pairs){
        if(!observations.has(pair.id))observations.set(pair.id,observePairReaction(source,pair));
      }
    }
    rows.push(measureTrendEntry(entry,snapshot));if(job.chart)chart=snapshot;
    if(i%4===0||i===job.entries.length-1){progress(i+1,job.entries.length);await new Promise<void>(resolve=>setTimeout(resolve,0));}
  }
  return {rows,reactions:summarizeReactions([...observations.values()]),snapshots:cache.size,families:observations.size,...(chart?{chart}:{})};
}
