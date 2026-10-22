import { getChatGPTUser } from '../../chatgpt-auth';
import { backupResponse, bootstrap, db, getTrade, importExecutions, importFirmPayouts, loadJournal, loadJournalVersion, bumpJournalRevision, saveCash, saveProfile, saveTradeNote, loadAccountState, saveAccountState, saveFirmReference,saveAdjustmentLabel } from '../../../lib/server-journal';
import { accountTradeGroups, centralDay, ordered, summarize } from '../../../lib/analytics';
import {validateRecorderImport} from '../../../lib/recorder-sync';
import {ACCOUNT_STATE_LIMIT} from '../../../lib/account-state';
import {netTradeSummary} from '../../../lib/trading-costs';
import {accountStage,flexAccount,flexEvaluation,flexPayoutDays} from '../../../lib/lucid-flex';
import {payoutSummary,payoutIncomeSummary} from '../../../lib/payouts';
import {summarizeRealized} from '../../../lib/realized';
import {loadPriceBars,savePriceBars,loadWeeklyGapBars} from '../../../lib/server-prices';
import {loadGapContexts} from '../../../lib/server-gap-context';
import {loadTrendEntries} from '../../../lib/server-trendline-entries';
import {loadAccountDayBalances} from '../../../lib/server-calendar-accounts';
import {loadDailyLoss} from '../../../lib/server-daily-loss';
import {DAILY_LOSS_REQUEST_BYTES} from '../../../lib/daily-loss';

export const dynamic='force-dynamic';
function json(value:unknown,status=200){return Response.json(value,{status,headers:{'Cache-Control':'no-store'}});}
async function handle(request:Request){
  const url=new URL(request.url),path=url.pathname.slice(5),method=request.method;
  try{
    const origin=request.headers.get('origin');if(method!=='GET'&&origin&&origin!==url.origin)return json({error:'This request must come from your dashboard.'},403);
    // This shared service route relies on Sites' enforced owner-private boundary.
    // It supports imports explicitly supplied by the owner and read-only checks,
    // using the same validation and deduplication as dashboard uploads.
    if(path==='maintenance'&&method==='POST'){
      const body=await request.json()as {action:string;offset?:number;payload?:Record<string,unknown>;day?:string;account?:string;payouts?:boolean;recent?:boolean};
      if(body.action==='backup')return backupResponse();
      if(body.action==='bootstrap')return json(await bootstrap(body.offset??0));
      if(body.action==='firm-reference')return json(await saveFirmReference(body.payload??{}));
      if(body.action==='account-profile')return json(await saveProfile(body.payload??{}));
      if(body.action==='account-day-balances')return json(await loadAccountDayBalances(body.payload??{}));
      if(body.action==='daily-loss'){
        if(new TextEncoder().encode(JSON.stringify(body.payload??{})).length>DAILY_LOSS_REQUEST_BYTES)return json({error:'Daily loss requests must be under 8 KB.'},413);
        return json(await loadDailyLoss(body.payload));
      }
      if(body.action==='import')return json(await importExecutions(body.payload??{}));
      if(body.action==='firm-payout-import')return json(await importFirmPayouts(body.payload??{}));
      if(body.action==='verify'){
        if(body.day&&!/^20\d{2}-\d{2}-\d{2}$/.test(body.day))return json({error:'Invalid report date.'},400);
        const [data,accountState]=await Promise.all([loadJournal(),loadAccountState()]),daily=body.day?data.trades.filter(t=>centralDay(t.exit)===body.day):[];
        const reference=data.firmReferences?.find(r=>r.account===body.account),stage=body.account?accountStage(body.account,data.profiles.find(p=>p.account===body.account),reference):null;
        const ledger={reportedSessions:data.reportedSessions,reportedCheckpoints:data.reportedCheckpoints,adjustments:data.adjustments,sessions:data.realizedSessions?.filter(row=>row.account===body.account),checkpoints:data.realizedCheckpoints?.filter(row=>row.account===body.account)};
        const flexProgress=body.account&&flexAccount(body.account)?{stage,...(stage==='Funded'?flexPayoutDays(body.account,data.trades,reference,data.cash,Date.now(),ledger):flexEvaluation(data.trades.filter(t=>t.account===body.account),reference?.flex?.consistencyPercent??null,ledger))}:null;
        return json({ready:data.ready,accounts:data.accounts.length,fills:data.accounts.reduce((s,a)=>s+a.fills,0),trades:data.trades.length,gross:Math.round(data.trades.reduce((s,t)=>s+t.pnl,0)*100)/100,issues:data.accounts.reduce((s,a)=>s+a.issues.length,0),cashRecords:data.cash.length,notes:data.notes.length,profileCount:data.profiles.length,accountSnapshots:accountState.accounts.length,lastAccountSnapshot:accountState.monitor?.capturedAt||null,firmReferenceCount:data.firmReferences?.length||0,flexProgress,balanceTracking:data.balanceTracking,adjustments:data.adjustments?.filter(row=>!body.account||row.account===body.account),firmAdjustments:data.firmAdjustments,...(body.payouts?{payoutReport:{summary:payoutSummary(data.cash),income:payoutIncomeSummary(data.cash),records:data.cash.filter(r=>r.firmPayout)}}:{}),
          ...(body.recent?{recentTrades:await Promise.all(ordered(data.trades.filter(t=>(!body.day||centralDay(t.exit)===body.day)&&(!body.account||t.account===body.account))).slice(-8).reverse().map(t=>getTrade(t.account,t.id)))}:{}),
          ...(body.account?{accountReview:{account:body.account,dayRealized:body.day?summarizeRealized((data.realized||[]).filter(row=>row.account===body.account&&row.day===body.day)):null,historyIssues:data.accounts.find(account=>account.account===body.account)?.issues||[],gross:summarize(data.trades.filter(t=>t.account===body.account)).gross,...(()=>{const {trades:_,...summary}=netTradeSummary(data.trades.filter(t=>t.account===body.account));return summary;})(),dayNet:body.day?(()=>{const ts=daily.filter(t=>t.account===body.account),{trades:_,...summary}=netTradeSummary(ts);return {gross:summarize(ts).gross,...summary};})():null,reference:data.firmReferences?.find(r=>r.account===body.account)||null,reported:accountState.accounts.find(a=>a.account===body.account)||null}}:{}),
          ...(body.day?{day:{date:body.day,...summarize(daily),accounts:[...accountTradeGroups(daily)].map(([account,trades])=>({account,...summarize(trades)}))}}:{})});
      }
      return json({error:'Unknown maintenance operation.'},400);
    }
    if(!await getChatGPTUser())return json({error:'Sign in with ChatGPT to open your private journal.'},401);
    if(path==='daily-loss'&&method==='POST'){
      const raw=await request.text();if(new TextEncoder().encode(raw).length>DAILY_LOSS_REQUEST_BYTES)return json({error:'Daily loss requests must be under 8 KB.'},413);
      return json(await loadDailyLoss(JSON.parse(raw)));
    }
    if(path==='account-day-balances'&&method==='POST'){
      const raw=await request.text();if(new TextEncoder().encode(raw).length>90000)return json({error:'Daily balance requests must be under 90 KB.'},413);
      return json(await loadAccountDayBalances(JSON.parse(raw)));
    }
    if(path==='trendline-entries'&&method==='POST'){
      const raw=await request.text();if(new TextEncoder().encode(raw).length>18000)return json({error:'Pilot requests must be under 18 KB.'},413);
      return json(await loadTrendEntries((JSON.parse(raw) as {trades:unknown}).trades));
    }
    if(path==='gap-context'&&method==='POST'){
      const raw=await request.text();if(new TextEncoder().encode(raw).length>10000)return json({error:'Context requests must be under 10 KB.'},413);
      return json(await loadGapContexts((JSON.parse(raw) as {trades:unknown}).trades));
    }
    if(path==='weekly-gap-bars'&&method==='GET')return json({bars:await loadWeeklyGapBars(url.searchParams.get('contract')||'',Number(url.searchParams.get('asOf')))});
    if(path==='prices'&&method==='GET')return json({bars:await loadPriceBars(url.searchParams.get('contract')||'',Number(url.searchParams.get('start')),Number(url.searchParams.get('end')))});
    if(path==='prices'&&method==='POST'){
      const raw=await request.text();if(raw.length>100000)return json({error:'Price batches must be under 100 KB.'},413);
      return json(await savePriceBars((JSON.parse(raw) as {bars:unknown}).bars));
    }
    if(path==='account-state'&&method==='GET')return json(await loadAccountState());
    if(path==='journal'&&method==='GET')return json(await loadJournal());
    if(path==='journal-version'&&method==='GET')return json(await loadJournalVersion());
    if(path==='bootstrap'&&method==='POST'){const body=await request.json()as {offset:number};return json(await bootstrap(body.offset));}
    if(path==='trade'&&method==='GET')return json(await getTrade(url.searchParams.get('account')||'',url.searchParams.get('id')||''));
    if(path==='backup'&&method==='GET')return backupResponse();
    if(path==='account-state'&&method==='POST'){const raw=await request.text();if(new TextEncoder().encode(raw).length>ACCOUNT_STATE_LIMIT)return json({error:'Account snapshots must be under 1 MB.'},413);return json(await saveAccountState(JSON.parse(raw)));}
    if(method==='POST'){
      const body=await request.json()as Record<string,unknown>;
      if(path==='cash')return json(await saveCash(body));
      if(path==='adjustment-label')return json(await saveAdjustmentLabel(body));
      if(path==='firm-payout-import')return json(await importFirmPayouts(body));
      if(path==='firm-reference')return json(await saveFirmReference(body));
      if(path==='profile')return json(await saveProfile(body));
      if(path==='note')return json(await saveTradeNote(body));
      if(path==='import')return json(await importExecutions(body));
      if(path==='recorder-import'){validateRecorderImport(body);return json(await importExecutions(body));}
    }
    if(path==='cash'&&method==='DELETE'){const body=await request.json()as {id:string};if(typeof body.id!=='string')return json({error:'Missing record.'},400);await db().prepare('DELETE FROM cash_records WHERE id=?').bind(body.id).run();await bumpJournalRevision();return json({ok:true});}
    return json({error:'Not found.'},404);
  }catch(e){console.error('Journal request failed',e);return json({error:e instanceof Error?e.message:'The request could not be completed.'},400);}
}
export const GET=handle;
export const POST=handle;
export const DELETE=handle;
