'use client';
import React from 'react';
import type {TrendEntryResult} from '../lib/trendlines';
import {dateLabel} from './ui';
export const priceLevelName=(type:string)=>type==='session-high'?'high':type==='session-low'?'low':'open';
export function EntryPriceContext({row}:{row:Pick<TrendEntryResult,'priceContext'|'weeklyContext'>}){
 const history=row.priceContext,gap=row.weeklyContext;
 const tags=gap?.tags??[],matches=history?.matches??[],nearest=history?.nearest;
 return <span className="entry-price-context">
  {tags.length>0&&<small>Weekly gap · {tags.map(t=>t==='near-edge'?'near edge':t==='near-midpoint'?'near midpoint':'inside zone').join(' / ')}</small>}
  {matches.slice(0,2).map(m=><small key={m.level.id}>{dateLabel(m.level.source)} session {priceLevelName(m.level.type)} · {m.distance.toFixed(2)} pts</small>)}
  {!tags.length&&gap?.nearest&&<small>Nearest gap: {dateLabel(gap.nearest.source)} · {gap.nearest.distance.toFixed(2)} pts</small>}
  {!matches.length&&nearest&&<small>Nearest: {dateLabel(nearest.level.source)} {priceLevelName(nearest.level.type)} · {nearest.distance.toFixed(2)} pts</small>}
  {!tags.length&&!nearest&&<small>Other levels unavailable</small>}
  {(history?.reason==='missing-entry-fill'||history?.reason==='missing-tolerance')&&<small className="muted">Entry comparison unavailable</small>}
  {((history?.status!=='measured'&&history?.reason!=='missing-entry-fill'&&history?.reason!=='missing-tolerance')||!!gap?.unavailable)&&<small className="muted">Historical coverage incomplete</small>}
 </span>;
}
