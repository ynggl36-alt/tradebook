import type { Fill } from './types';
const pointValues:Record<string,number>={CL:1000,ES:50,MCL:100,MES:5,MGC:10,MNQ:2,NQ:20,SI:5000,SIL:1000};
const norm=(s:string)=>s.replace(/^\uFEFF/,'').toLowerCase().replace(/[^a-z0-9]/g,'');
export function parseDelimited(input:string) {
  const first=input.split(/\r?\n/)[0]||'';
  const separator=['\t',';',','].sort((a,b)=>first.split(b).length-first.split(a).length)[0];
  const rows:string[][]=[];let row:string[]=[],field='',quoted=false;
  for(let i=0;i<input.length;i++){const c=input[i];if(c==='"'){if(quoted&&input[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
    else if(c===separator&&!quoted){row.push(field);field='';}
    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&input[i+1]==='\n')i++;row.push(field);if(row.some(x=>x.trim()))rows.push(row);row=[];field='';}else field+=c;}
  if(quoted)throw new Error('A quoted field is incomplete. Export the file again.');row.push(field);if(row.some(x=>x.trim()))rows.push(row);return rows;
}
export function normalizeContract(raw:string) {
  const s=raw.trim().toUpperCase().replace(/\s+/g,' ');
  let m=s.match(/^([A-Z]+)\s+(\d{4})-(\d{2})$/);let symbol:string,year:string,month:string;
  if(m){[,symbol,year,month]=m;}else{m=s.match(/^([A-Z]+)\s+(\d{2})-(\d{2}|\d{4})$/);if(!m)throw new Error('Contract must include its expiry, for example MNQ 12-26.');symbol=m[1];month=m[2];year=m[3].length===2?'20'+m[3]:m[3];}
  if(!pointValues[symbol])throw new Error('Unsupported contract '+symbol+'. Its dollar point value needs to be configured first.');
  if(Number(month)<1||Number(month)>12)throw new Error('Invalid contract month.');
  return {contract:symbol+' '+year+'-'+month,symbol,pv:pointValues[symbol]};
}
function numberValue(s:string) { const clean=s.trim().replace(/[$£€\s]/g,'').replace(/,/g,'');return clean!==''?Number(clean):NaN; }
function reportedPosition(raw:string) {
  const s=raw.trim();if(!s)return null;
  if(s==='-'||/^flat$/i.test(s))return 0;
  if(/^-?\d+$/.test(s))return Number(s);
  const m=s.match(/^(\d+)\s*(L|S|Long|Short)$/i);
  if(m)return Number(m[1])*(/^s/i.test(m[2])?-1:1);
  throw new Error('Unrecognized position '+s+'.');
}
function localComponents(ms:number,zone:string){const values=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms));const p=Object.fromEntries(values.map(x=>[x.type,x.value]));return [Number(p.year),Number(p.month),Number(p.day),Number(p.hour),Number(p.minute),Number(p.second)];}
export function parseTimestamp(raw:string,zone:string) {
  const s=raw.trim();
  if(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)){const ms=Date.parse(s);if(!Number.isFinite(ms))throw new Error('Invalid timestamp.');return new Date(ms).toISOString();}
  let m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})(?:[.:](\d{1,7}))?(?:\s*(AM|PM))?$/i);
  let y:number,mo:number,d:number,h:number,mi:number,se:number,milli:number,amp:string|undefined;
  if(m){y=+m[1];mo=+m[2];d=+m[3];h=+m[4];mi=+m[5];se=+m[6];milli=+(m[7]||'').padEnd(3,'0').slice(0,3);amp=m[8];}
  else{m=s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})(?:[.:](\d{1,7}))?(?:\s*(AM|PM))?$/i);if(!m)throw new Error('Use a timestamp including date, hours, minutes and seconds.');mo=+m[1];d=+m[2];y=+m[3];if(y<100)y+=2000;h=+m[4];mi=+m[5];se=+m[6];milli=+(m[7]||'').padEnd(3,'0').slice(0,3);amp=m[8];}
  if(amp){if(h<1||h>12)throw new Error('Invalid 12-hour clock.');h=h%12+(amp.toUpperCase()==='PM'?12:0);}
  if(mo<1||mo>12||d<1||d>31||h>23||mi>59||se>59)throw new Error('Invalid date or time.');
  const desired=Date.UTC(y,mo-1,d,h,mi,se,milli);
  if(new Date(desired).getUTCDate()!==d)throw new Error('Invalid calendar date.');
  let guess=desired;
  for(let i=0;i<4;i++){const a=localComponents(guess,zone);const local=Date.UTC(a[0],a[1]-1,a[2],a[3],a[4],a[5],milli);const delta=desired-local;guess+=delta;if(!delta)break;}
  const target=[y,mo,d,h,mi,se],same=(at:number)=>localComponents(at,zone).every((x,i)=>x===target[i]);
  if(!same(guess))throw new Error('This local time falls in a daylight-saving gap. Export timestamps in UTC.');
  if(same(guess-3600000)||same(guess+3600000))throw new Error('This local time is ambiguous at the daylight-saving change. Export timestamps in UTC.');
  return new Date(guess).toISOString();
}
export function parseExecutionCsv(input:string,zone='America/Chicago') {
  const rows=parseDelimited(input);if(rows.length<2)throw new Error('No execution rows were found.');
  const headers=rows[0].map(norm);const column=(...names:string[])=>headers.findIndex(h=>names.map(norm).includes(h));
  const actualAccount=column('account','accountname');
  const cols={account:actualAccount>=0?actualAccount:column('accountdisplayname'),contract:column('instrument','contract'),side:column('action','side','marketposition'),qty:column('quantity','qty'),price:column('price','fillprice'),time:column('time','timestamp','executiontime'),id:column('id','executionid','execid'),pos:column('position','reportedposition'),entry:column('ex','entryexit','isentry')};
  for(const k of ['account','contract','side','qty','price','time','id'] as const)if(cols[k]<0)throw new Error('Missing '+k+' column. Export the Executions view, including Account and ID. Found: '+rows[0].join(', '));
  const fills:(Fill&{account:string})[]=[];
  for(let i=1;i<rows.length;i++){
    const row=rows[i];const get=(k:keyof typeof cols)=>cols[k]>=0?(row[cols[k]]||'').trim():'';
    try{
      const account=get('account'),id=get('id');if(!account||!id)throw new Error('Account and execution ID are required.');
      const contract=normalizeContract(get('contract'));const action=get('side').toLowerCase().replace(/\s+/g,'');
      const side=/^(buy|buytocover|long)$/.test(action)?'Buy':/^(sell|sellshort|short)$/.test(action)?'Sell':null;if(!side)throw new Error('Unrecognized action '+get('side')+'.');
      const qty=numberValue(get('qty')),price=numberValue(get('price'));if(!Number.isInteger(qty)||qty<=0||!Number.isFinite(price)||price<=0)throw new Error('Price and quantity must be positive; quantity must be a whole number.');
      const pos=reportedPosition(get('pos'));
      const entry=get('entry').toLowerCase();const entryFlag=/^(entry|e|true|1)$/.test(entry)?true:/^(exit|x|false|0)$/.test(entry)?false:null;
      fills.push({account,id,...contract,side,qty,price,time:parseTimestamp(get('time'),zone),ordinal:i,pos,entryFlag});
    }catch(e){throw new Error('Row '+(i+1)+': '+(e instanceof Error?e.message:String(e)));}
  }
  // Native grids can be sorted newest first. Preserve the chronological order
  // of same-second partial fills instead of feeding their reversed positions
  // to the reconstruction engine. Mixed/arbitrary sorts retain their tie order;
  // reported positions still expose missing or inconsistent sequences.
  const streams=new Map<string,{last:string;direction:number;mixed:boolean}>();
  const key=(f:Fill&{account:string})=>JSON.stringify([f.account,f.contract]);
  for(const f of fills){const k=key(f),s=streams.get(k);if(!s){streams.set(k,{last:f.time,direction:0,mixed:false});continue;}const d=Math.sign(f.time.localeCompare(s.last));if(d){if(s.direction&&s.direction!==d)s.mixed=true;else s.direction=d;}s.last=f.time;}
  fills.sort((a,b)=>a.time.localeCompare(b.time)||a.account.localeCompare(b.account)||a.contract.localeCompare(b.contract)||((streams.get(key(a))?.direction===-1&&!streams.get(key(a))?.mixed)?b.ordinal-a.ordinal:a.ordinal-b.ordinal));
  return fills.map((f,i)=>({...f,ordinal:i+1}));
}
