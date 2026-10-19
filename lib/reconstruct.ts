import type { AccountHistory, Fill, HistoryIssue, Trade } from './types';
import { round } from './analytics';

async function tradeId(account:string, contract:string, id:string, offset:number) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode([account,contract,id,String(offset)].join('|')));
  return 'T-'+Array.from(new Uint8Array(bytes)).map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,20);
}
export function sameFill(a:Fill,b:Fill){
  // Native execution exports can display less timestamp precision than the database.
  return a.id===b.id&&a.contract===b.contract&&a.side===b.side&&a.qty===b.qty&&Math.abs(a.price-b.price)<1e-8&&Math.abs(Date.parse(a.time)-Date.parse(b.time))<1000;
}
export function mergeFills(existing:Fill[],incoming:Fill[]) {
  const map=new Map(existing.map(f=>[f.id,f]));let added=0,duplicates=0;const conflicts:string[]=[];
  let ordinal=Math.max(0,...existing.map(f=>f.ordinal));
  for(const row of incoming){const old=map.get(row.id);if(old){if(sameFill(old,row))duplicates++;else conflicts.push(row.id);}else{map.set(row.id,{...row,ordinal:++ordinal});added++;}}
  return {fills:[...map.values()].sort((a,b)=>a.time.localeCompare(b.time)||a.ordinal-b.ordinal),added,duplicates,conflicts};
}
export async function reconstruct(account:string, fills:Fill[]):Promise<AccountHistory> {
  const streams=new Map<string,Fill[]>();
  for(const f of fills){if(!streams.has(f.contract))streams.set(f.contract,[]);streams.get(f.contract)!.push(f);}
  const trades:Trade[]=[],issues:HistoryIssue[]=[];
  for(const [contract,source] of streams){
    const fs=[...source].sort((a,b)=>a.time.localeCompare(b.time)||a.ordinal-b.ordinal);
    let pos=0;
    let ep:null|{id:string,dir:'Long'|'Short',entry:string,exit:string,entryQty:number,exitQty:number,entryValue:number,exitValue:number,buy:number,sell:number,max:number,known:boolean,pv:number,symbol:string,order:number,parts:[string,number,number,string][]}=null;
    const finish=(reason?:string)=>{
      if(!ep)return;
      if(reason||!ep.known||pos!==0||ep.entryQty!==ep.exitQty||ep.entryQty===0){issues.push({contract,reason:reason||'Missing entry in available history',time:ep.entry,remaining:pos});}
      else trades.push({id:ep.id,account,contract,symbol:ep.symbol,dir:ep.dir,entry:ep.entry,exit:ep.exit,qty:ep.entryQty,maxQty:ep.max,
        avgEntry:ep.entryValue/ep.entryQty,avgExit:ep.exitValue/ep.exitQty,pnl:round((ep.sell-ep.buy)*ep.pv),exitOrder:ep.order,parts:ep.parts});
      ep=null;
    };
    const start=async(f:Fill,sign:number,known:boolean,offset=0)=>({id:await tradeId(account,contract,f.id,offset),dir:(sign>0?'Long':'Short')as 'Long'|'Short',entry:f.time,exit:f.time,entryQty:0,exitQty:0,entryValue:0,exitValue:0,buy:0,sell:0,max:Math.abs(pos),known,pv:f.pv,symbol:f.symbol,order:f.ordinal,parts:[] as [string,number,number,string][]});
    for(const f of fs){
      const sign=f.side==='Buy'?1:-1;
      if(f.pos!==null){const before=f.pos-sign*f.qty;if(before!==pos){finish('Position discontinuity: missing or inconsistent executions');pos=before;}}
      if(!ep&&pos!==0)ep=await start(f,pos,false);
      if(!ep&&pos===0&&f.pos===null&&f.entryFlag===false){issues.push({contract,reason:'Exit without an entry in the available history',time:f.time,remaining:0});continue;}
      let left=f.qty,offset=0;
      while(left>0){
        const opening=pos===0||pos*sign>0;
        if(!ep)ep=await start(f,sign,true,offset);
        const part=opening?left:Math.min(left,Math.abs(pos));
        if(sign>0)ep.buy+=part*f.price;else ep.sell+=part*f.price;
        if(opening){ep.entryQty+=part;ep.entryValue+=part*f.price;}else{ep.exitQty+=part;ep.exitValue+=part*f.price;}
        ep.parts.push([f.id,part,f.price,f.side]);pos+=sign*part;ep.max=Math.max(ep.max,Math.abs(pos));ep.exit=f.time;ep.order=f.ordinal;
        left-=part;offset+=part;if(pos===0)finish();
      }
    }
    if(ep)finish(pos!==0?'Unclosed position in available history':undefined);
  }
  return {account,fills,trades:trades.sort((a,b)=>a.entry.localeCompare(b.entry)||a.id.localeCompare(b.id)),issues};
}
