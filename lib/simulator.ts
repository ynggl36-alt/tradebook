import type {AccountHistory,Fill} from './types';
import {reconstruct} from './reconstruct';

export type SimulatorSnapshot={name:string;savedAt:number;fills:Fill[]};
export async function buildSimulatorHistory(snapshots:SimulatorSnapshot[]):Promise<AccountHistory>{
  const unique=new Map<string,Fill>();
  for(const snapshot of snapshots){
    for(const fill of snapshot.fills){
      const previous=unique.get(fill.id);
      if(previous){
        if(previous.contract!==fill.contract||previous.side!==fill.side||previous.qty!==fill.qty||previous.price!==fill.price||Date.parse(previous.time)!==Date.parse(fill.time)||previous.pos!==fill.pos)
          throw new Error('Conflicting Sim101 execution '+fill.id+'. Check the source captures before reviewing these results.');
      }else unique.set(fill.id,fill);
    }
  }
  const fills=[...unique.values()].sort((a,b)=>a.time.localeCompare(b.time)||a.ordinal-b.ordinal);
  return reconstruct('Sim101',fills);
}
