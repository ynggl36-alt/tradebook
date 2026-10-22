import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DailyLossResults,DailyLossView} from '../app/daily-loss-view';
import {dailyLossSessions} from '../lib/daily-loss';
import type {RealizedEvent} from '../lib/realized';
import type {DailyLossRun} from '../lib/daily-loss-runner';

const account='LFF05000000000021',evaluation='LFE05000000000022',day='2026-10-21';
function event(account:string,net:number,time='2026-10-21T14:00:00Z'):RealizedEvent{return {account,contract:'NQ 2026-12',symbol:'NQ',time,ordinal:1,fillId:account+time,gross:net,commissions:0,net,exits:1,quantity:1,unmatched:0,coverageIssues:0};}
function data():DailyLossRun{
 const funded=dailyLossSessions(account,[event(account,-1275),event(account,1500,'2026-10-21T15:00:00Z')],day,day,{stage:'Funded',markedUpgraded:false});
 const evals=dailyLossSessions(evaluation,[{...event(evaluation,-1500),net:null,commissions:null,unmatched:1,coverageIssues:1}],day,day,{stage:'Evaluation',markedUpgraded:true});
 return {rows:[...funded,...evals],unavailable:[],excluded:[],checkedAccounts:2,requestedAccounts:2,limited:false,asOf:'2026-10-22T00:00:00Z'};
}
const render=(result:DailyLossRun)=>renderToStaticMarkup(createElement(DailyLossResults,{result,profiles:new Map(),onAccount:()=>{}}));
test('rendered daily loss results separate funded/evaluations and show actual overshoot, recovery and unknown coverage',()=>{
 const result=data(),before=JSON.stringify(result),html=render(result);
 assert.match(html,/Worst realized net/);assert.match(html,/Peak giveback/);assert.match(html,/Later actual change/);assert.match(html,/-\$1,275\.00/);assert.match(html,/\+\$1,500\.00/);assert.match(html,/Recovered above/);assert.match(html,/Ended above/);assert.match(html,/Funded/);assert.match(html,/Evaluations/);assert.match(html,/Marked upgraded/);assert.match(html,/fees missing/);assert.match(html,/inventory gaps/);assert.match(html,/Unknown/);assert.equal((html.match(/data-crossed="true"/g)||[]).length,1);
 assert.doesNotMatch(html,/Passed evaluation|Account failed|Money saved|Breach count|"fillId"/);assert.equal(JSON.stringify(result),before);
});
test('rendered partial/unavailable reports make omitted accounts visible and retain the requested population',()=>{
 const result=data();result.limited=true;result.requestedAccounts=501;result.unavailable=[{account:'SYNTHETIC-UNAVAILABLE',reason:'history-limit'}];
 const html=render(result);assert.match(html,/Partial report/);assert.match(html,/2 of 501/);assert.match(html,/1 account unavailable/);assert.match(html,/History exceeds this bounded analysis/);assert.match(html,/Counts below describe the loaded portion/);
});
test('the scenario introduction exposes whole-account scope, commission limitations and official rules without assigning an account product',()=>{
 const html=renderToStaticMarkup(createElement(DailyLossView,{accounts:[account],start:day,end:day,stage:'all',profiles:new Map(),refreshKey:'synthetic',onAccount:()=>{}}));
 assert.match(html,/every contract in each account/);assert.match(html,/Only evaluations marked upgraded/);assert.match(html,/floating P&amp;L|Floating P&amp;L/);assert.match(html,/not a confirmed firm breach/);assert.match(html,/does not assign purchased rules/);assert.match(html,/support\.lucidtrading\.com\/en\/articles\/16226050-lucidflex-customization/);assert.match(html,/scheduled commission/);assert.match(html,/role="status"/);
});
