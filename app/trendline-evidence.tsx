'use client';
import React from 'react';
import {ChevronRight} from 'lucide-react';
import {ATTRIBUTION_REASONS,ENTRY_STYLE_LABELS,EVIDENCE_LABELS} from '../lib/trendline-attribution';
import type {TrendAttribution} from '../lib/trendline-attribution';
import {timeLabel} from './ui';
export function attributionLabel(value:TrendAttribution|undefined){return value?.ambiguous?'Timing ambiguous':value?.style?ENTRY_STYLE_LABELS[value.style]:value?.status==='near-only'?'Proximity only':value?.status==='unavailable'?'Evidence unavailable':'Unclassified';}
export function EvidenceBadge({value}:{value:TrendAttribution|undefined}){return <span className={'trend-evidence-badge '+(value?.confidence??'unclassified')}>{value?.status==='matched'?EVIDENCE_LABELS[value.confidence]:'Unclassified'}</span>;}
export function TrendlineEvidence({value,onFocus}:{value:TrendAttribution|undefined;onFocus:()=>void}){
  if(!value)return null;
  const match=value.match;
  return <div className="trend-entry-evidence"><div className="trend-entry-evidence-title"><strong>{attributionLabel(value)}</strong><EvidenceBadge value={value}/><small>Calibration preview</small>{match&&<button className="button subtle small" onClick={onFocus}>Highlight matched path</button>}</div>{match&&<p>{match.minutes}m {match.polarity} · {match.anchorStyles.join(' / ')} anchors · {match.distance.toFixed(2)} points from the line at first fill. {match.priorTests} independent test{match.priorTests===1?'':'s'} before this approach.</p>}{value.ambiguous&&match&&<p>Timing also fits: {[match.style,...value.alternativeStyles].map(style=>ENTRY_STYLE_LABELS[style]).join(" / ")}. This entry stays out of the three timing counts.</p>}<details><summary>Why this label <ChevronRight size={12}/></summary><ul>{value.reasons.map(reason=><li key={reason}>{ATTRIBUTION_REASONS[reason]||reason}</li>)}</ul>{match?.contactAt!==null&&match?.contactAt!==undefined&&<p>Contact-zone candle: {timeLabel(new Date(match.contactAt).toISOString())}–{timeLabel(new Date(match.contactAt+60000).toISOString())} CT.{match.rejectedAt!==null?' Separate close away completed '+timeLabel(new Date(match.rejectedAt).toISOString())+' CT.':''}</p>}<p>Stronger evidence describes the observed match under provisional rules. It does not establish your intent or a higher probability of profit. Other contexts, including weekly gaps, can coexist.</p></details></div>;
}
