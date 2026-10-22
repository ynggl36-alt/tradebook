import {attributeTrendEntry} from './trendline-attribution';
import type {PriceBar} from './recorder';
import {measureTrendEntry,observePairReaction,prepareTrends,scanTrends,summarizeReactions} from './trendlines';
import type {ReactionCheck,ReactionSummary,TrendEntry,TrendEntryResult,TrendSnapshot} from './trendlines';
import {preparePriceContext,priceContext,matchPriceContext} from './price-context';
import type {PriceContext} from './price-context';
import {weeklyBoundaryStarts,weeklyGapContext} from './weekly-gaps';
export type TrendJob={id:string;entries:TrendEntry[];prices:PriceBar[];chart?:boolean};
export type TrendJobResult={rows:TrendEntryResult[];reactions:ReactionSummary;snapshots:number;families:number;chart?:TrendSnapshot;chartContext?:PriceContext};
export type TrendWorkerMessage={id:string;progress?:number;total?:number;result?:TrendJobResult;error?:string};
export async function runTrendJob(job:TrendJob,progress:(checked:number,total:number)=>void=()=>{}):Promise<TrendJobResult>{
  const contracts=[...new Set(job.entries.map(e=>e.contract))],prepared=new Map(contracts.map(c=>[c,prepareTrends(job.prices,c)]));
  const contexts=new Map(contracts.map(c=>[c,preparePriceContext(job.prices,c)])),contextCache=new Map<string,PriceContext>();
  const boundaryStarts=new Set(job.entries.flatMap(e=>weeklyBoundaryStarts(Math.floor(Date.parse(e.entry)/60000)*60000))),gapPrices=job.prices.filter(b=>boundaryStarts.has(b.start));
  const cache=new Map<string,TrendSnapshot>(),observations=new Map<string,ReactionCheck>(),rows:TrendEntryResult[]=[];
  let chart:TrendSnapshot|undefined,chartContext:PriceContext|undefined;
  for(let i=0;i<job.entries.length;i++){
    const entry=job.entries[i],key=entry.contract+'|'+Math.floor(Date.parse(entry.entry)/60000),source=prepared.get(entry.contract)!;
    let snapshot=cache.get(key);
    if(!snapshot){
      const scan=scanTrends(source,Date.parse(entry.entry));snapshot=scan.snapshot;cache.set(key,snapshot);
      if(!job.chart)for(const pair of scan.pairs){
        if(!observations.has(pair.id))observations.set(pair.id,observePairReaction(source,pair));
      }
    }
    let context=contextCache.get(key);if(!context){context=priceContext(entry.contract,Date.parse(entry.entry),contexts.get(entry.contract)!);contextCache.set(key,context);}
    const row=measureTrendEntry(entry,snapshot);row.attribution=attributeTrendEntry(entry,snapshot,source);
    row.priceContext={...matchPriceContext(context,entry.entryPrice,snapshot.tolerance),sources:context.sources.length,completeSources:context.sources.filter(s=>s.status==='complete').length,lookbackStart:context.lookbackStart};
    const gaps=weeklyGapContext(entry.contract,snapshot.asOf,gapPrices);
    row.weeklyContext={known:gaps.gaps.length,unavailable:gaps.unavailable,tags:[],nearest:null};
    if(entry.entryPrice!==null&&snapshot.tolerance!==null&&gaps.gaps.length){
      const levels=gaps.gaps.flatMap(g=>[{source:g.sunday,price:g.low,kind:'edge'},{source:g.sunday,price:g.high,kind:'edge'},{source:g.sunday,price:g.midpoint,kind:'midpoint'}]);
      const distances=levels.map(l=>({...l,distance:Math.abs(entry.entryPrice!-l.price)})).sort((a,b)=>a.distance-b.distance||a.source.localeCompare(b.source));
      const nearest=distances[0];row.weeklyContext.nearest={source:nearest.source,price:nearest.price,distance:nearest.distance};
      if(distances.some(l=>l.kind==='edge'&&l.distance<=snapshot.tolerance!))row.weeklyContext.tags.push('near-edge');
      if(distances.some(l=>l.kind==='midpoint'&&l.distance<=snapshot.tolerance!))row.weeklyContext.tags.push('near-midpoint');
      if(gaps.gaps.some(g=>entry.entryPrice!>=g.low&&entry.entryPrice!<=g.high))row.weeklyContext.tags.push('inside-zone');
    }
    rows.push(row);if(job.chart){chart=snapshot;chartContext=context;}
    if(i%4===0||i===job.entries.length-1){progress(i+1,job.entries.length);await new Promise<void>(resolve=>setTimeout(resolve,0));}
  }
  return {rows,reactions:summarizeReactions([...observations.values()]),snapshots:cache.size,families:observations.size,...(chart?{chart,chartContext}:{})};
}
