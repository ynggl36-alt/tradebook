'use client';
import React from 'react';
import {PERFORMANCE_STAGES,type PerformanceStage} from '../lib/performance-scope';

export function StageFilter({value,onChange}:{value:PerformanceStage;onChange:(stage:PerformanceStage)=>void}){
 return <div className="segmented stage-filter" role="group" aria-label="Account stage">{PERFORMANCE_STAGES.map(stage=><button key={stage.value} type="button" aria-pressed={value===stage.value} className={value===stage.value?'selected':''} onClick={()=>onChange(stage.value)}>{stage.label}</button>)}</div>;
}
