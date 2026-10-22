import {addDays,centralDay,centralHour} from './analytics';
// The futures trading day begins at 17:00 Chicago, including DST changes.
export function flexSession(time:string){const day=centralDay(time);return centralHour(time)>=17?addDays(day,1):day;}

export function flexSessionStart(day:string){
 const previous=addDays(day,-1),summer=Date.parse(previous+'T22:00:00.000Z');
 return new Date(summer+(centralHour(new Date(summer).toISOString())===17?0:3600000)).toISOString();
}
