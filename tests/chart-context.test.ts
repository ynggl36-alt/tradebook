import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chartHorizontals,chartTrendLines,chartEndpointMarkerIds} from '../lib/chart-context';
import {executionMarkers} from '../lib/recorder';
import type {Fill,Trade} from '../lib/types';
import type {HistoricalPriceLevel} from '../lib/price-context';
import type {WeeklyGap} from '../lib/weekly-gaps';
import type {TrendLine} from '../lib/trendlines';
const at=Date.parse('2026-10-20T14:00:00Z'),M=60000,contract='NQ 2026-12';
function level(id:string,price:number,availableAt=at-M):HistoricalPriceLevel{return{id,contract,type:'session-high',source:'2026-10-19',start:at-86400000,end:availableAt,availableAt,price};}
function gap(id:string,low:number,high:number):WeeklyGap{return{id,contract,sunday:'2026-10-18',fridayCloseAt:at-4*86400000,sundayOpenAt:at-2*86400000,fridayClose:low,sundayOpen:high,low,high,midpoint:(low+high)/2};}
function line(id:string,value:number,slope=0):TrendLine{const a={time:at-90*M,price:value-slope*90*M,edge:'wick' as const,impulse:false,availableAt:at-80*M};return{id,family:contract+'|'+id,minutes:5,polarity:'support',style:'wick',a,b:{...a,time:at-50*M,price:value-slope*50*M},availableAt:at-40*M,asOf:at,value,slope,touches:2,wickTouches:2,bodyTouches:0,broken:false,score:100,segmentStart:at-100*M,segmentEnd:at,structureValid:true};}

test('weekly gaps and historical levels share two slots; overlapping sources do not consume another',()=>{
 const levels=[level('edge',100),level('same-source-price',100.1),level('separate',104),level('farther',110)],gaps=[gap('gap',99,101),gap('overlapping',100,102)];
 const original=JSON.stringify({levels,gaps});const selected=chartHorizontals(levels,gaps,contract,at,100,80,120,.5);
 assert.deepEqual(selected.map(r=>r.id),['gap','separate']);assert.equal(JSON.stringify({levels,gaps}),original);
 assert.deepEqual(chartHorizontals([...levels].reverse(),[...gaps].reverse(),contract,at,100,80,120,.5),selected);
});
test('future or foreign references never displace a known level; missing first fill stays unranked',()=>{
 const known=level('known',105),future=level('future',100,at+M),foreign={...level('foreign',100),contract:'MES 2026-12'};
 const unconfirmed={...gap('opening-minute',99,101),sundayOpenAt:at};
 assert.deepEqual(chartHorizontals([known,future,foreign],[unconfirmed],contract,at+15000,100,90,110,1).map(r=>r.id),['known']);
 assert.deepEqual(chartHorizontals([known],[],contract,at,null,90,110,1),[]);
});
test('two distinct display paths retain the preferred evidence without filling slots with close variants',()=>{
 const lines=[line('near',100),line('close-variant',100.2),line('other',104),line('preferred',110)];
 const original=JSON.stringify(lines),selected=chartTrendLines(lines,contract,at,100,1,'preferred');
 assert.deepEqual(selected.map(l=>l.id),['preferred','near']);assert.equal(JSON.stringify(lines),original);
 assert.deepEqual(chartTrendLines([...lines].reverse(),contract,at,100,1,'preferred'),selected);
 assert.deepEqual(chartTrendLines(lines,contract,at,100,1,null).map(l=>l.id),['near','other']);
});
test('broken, stale or future paths cannot win a chart slot even when requested by id',()=>{
 const good=line('good',101),broken={...line('broken',100),broken:true},future={...line('future',100),availableAt:at+M},stale={...line('stale',100),asOf:at-M};
 assert.deepEqual(chartTrendLines([good,broken,future,stale],contract,at,100,.5,'broken').map(l=>l.id),['good']);
 assert.deepEqual(chartTrendLines([good],contract,at,null,.5,null),[]);
});

test('a missing endpoint allocation never promotes a scale-in or partial exit to E/X',()=>{
 const trade:Trade={id:'synthetic',account:'SYNTHETIC',contract,symbol:'NQ',dir:'Long',entry:new Date(at).toISOString(),exit:new Date(at+3*M).toISOString(),qty:2,maxQty:2,avgEntry:100,avgExit:101,pnl:40,exitOrder:0,parts:[['a',1,100,'Buy'],['b',1,100,'Buy'],['c',1,101,'Sell'],['d',1,101,'Sell']]};
 const fills:Fill[]=trade.parts!.map((p,i)=>({id:p[0],contract,symbol:'NQ',pv:20,time:new Date(at+i*M).toISOString(),ordinal:i,side:p[3]as'Buy'|'Sell',qty:p[1],price:p[2],pos:null}));
 assert.deepEqual(chartEndpointMarkerIds(trade,fills,executionMarkers(trade,fills)),{entryId:'a:0',exitId:'d:3'});
 const incomplete=fills.slice(1,-1),markers=executionMarkers(trade,incomplete);
 assert.equal(markers.length,2);assert.deepEqual(chartEndpointMarkerIds(trade,incomplete,markers),{entryId:null,exitId:null});
});
