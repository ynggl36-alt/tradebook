// Primary-key cursors keep each read bounded as retained evidence grows. Array
// order is a transport detail; identifiers and all source fields stay intact.
const sections=[
 {name:'profiles',table:'account_profiles',keys:['account'],data:'data',size:500},
 {name:'notes',table:'trade_notes',keys:['id'],data:'data',size:500},
 {name:'cash',table:'cash_records',keys:['id'],data:'data',size:500},
 {name:'imports',table:'journal_imports',keys:['id'],data:"json_object('id',id,'source',source,'added',added,'duplicates',duplicates,'importedAt',imported_at)",size:500},
 // Account history is a much larger JSON payload than the evidence rows.
 {name:'history',table:'account_history',keys:['account'],data:'data',size:4},
 {name:'balanceObservations',table:'account_observations',keys:['id'],data:"json_set(data,'$.receivedAt',received_at)",size:500},
 {name:'recorderCaptures',table:'recorder_captures',keys:['captured_at'],data:"json_set(data,'$.receivedAt',received_at)",size:500},
 {name:'adjustmentLabels',table:'balance_adjustment_labels',keys:['id'],data:'data',size:500},
 {name:'executionTimes',table:'execution_times',keys:['account','time'],data:"json_object('account',account,'time',time)",size:500},
 {name:'priceBars',table:'price_bars',keys:['contract','start'],data:"json_object('id',contract||'|'||start,'contract',contract,'start',start,'end',start+60000,'open',open,'high',high,'low',low,'close',close,'volume',volume,'capturedAt',captured_at,'receivedAt',received_at)",size:500},
] as const;
type Row={data:string;[key:string]:string|number};

export function journalBackupResponse(database:Pick<D1Database,'prepare'>,metadata:Record<string,unknown>){
 async function* chunks(){
  yield JSON.stringify(metadata).slice(0,-1);
  for(const section of sections){
   yield ','+JSON.stringify(section.name)+':[';
   let cursor:(string|number)[]|undefined,wrote=false;
   for(;;){
    const keys=section.keys.join(','),where=cursor?` WHERE (${keys})>(${section.keys.map(()=>'?').join(',')})`:'';
    const statement=database.prepare(`SELECT ${keys},${section.data} AS data FROM ${section.table}${where} ORDER BY ${keys} LIMIT ${section.size}`);
    const rows=await (cursor?statement.bind(...cursor):statement).all<Row>();
    if(rows.results.length){
     const last=rows.results.at(-1)!;cursor=section.keys.map(key=>last[key]);
     yield (wrote?',':'')+rows.results.map(row=>row.data).join(',');wrote=true;
    }
    if(rows.results.length<section.size)break;
   }
   yield ']';
  }
  yield '}';
 }
 const encoder=new TextEncoder(),iterator=chunks();
 const stream=new ReadableStream<Uint8Array>({
  async pull(controller){try{const next=await iterator.next();if(typeof next.value==='string')controller.enqueue(encoder.encode(next.value));else controller.close();}catch(error){controller.error(error);}},
  async cancel(){await iterator.return(undefined);},
 });
 return new Response(stream,{headers:{'Content-Type':'application/json','Content-Disposition':'attachment; filename="Tradebook-backup-'+String(metadata.exportedAt).slice(0,10)+'.json"','Cache-Control':'no-store'}});
}
