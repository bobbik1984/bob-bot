import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarPreview,dailyAgenda,eventFile} from './web/calendar.mjs';
const wrap=rows=>['BEGIN:VCALENDAR',...rows.flatMap(row=>['BEGIN:VEVENT',...row,'END:VEVENT']),'END:VCALENDAR'].join('\r\n');
const fields=(when,extra=[])=>['UID:1','SUMMARY:Meet\\, then','  eat','LOCATION:West\\;Bank',when,...extra];
test('UTC, folded and escaped text, alarms, repeat exceptions and explicit TZID',()=>{
 const now=Date.UTC(2026,0,1);
 const p=calendarPreview(wrap([fields('DTSTART;TZID="Asia/Shanghai":20260201T183000',['BEGIN:VALARM','SUMMARY:ignore','END:VALARM']),
 fields('DTSTART:20260210T153000Z',['RRULE:FREQ=WEEKLY'])]),now);
 assert.equal(p.skipped,1);assert.deepEqual(p.events,[{uid:'1',text:'Meet, then eat',place:'West;Bank',at:Date.UTC(2026,1,1,10,30)}]);
 assert.equal(calendarPreview(wrap([fields('DTSTART:20260210T153000Z')]),now).events[0].at,Date.UTC(2026,1,10,15,30));
});
test('unsupported, ambiguous, nonexistent, invalid, past and cancelled times are skipped',()=>{
 for(const f of [fields('DTSTART;VALUE=DATE:20260301'),fields('DTSTART:20260230T120000Z'),fields('DTSTART;TZID=Fake/Here:20260301T090000'),fields('DTSTART;TZID=America/New_York:20261101T013000'),fields('DTSTART;TZID=America/New_York:20260308T023000'),fields('DTSTART:20260101T010000Z',['STATUS:CANCELLED'])]){
   assert.equal(calendarPreview(wrap([f]),Date.UTC(2026,0,1)).skipped,1)
 }
 assert.throws(()=>calendarPreview('junk'));
});
test('agenda uses local day boundaries and excludes bookmarks and completed work',()=>{
 const day=new Date(2026,1,1,9),early=new Date(2026,1,1,0).getTime();
 const row={At:early,Kind:'wish',Status:'open'};
 assert.deepEqual(dailyAgenda([row,{...row,At:early-1},{...row,Kind:'save'},{...row,Status:'done'}],day),[row]);
});

test('calendar draft round trips UTF-8 folded lines and escapes titles',()=>{
 const title='看展，'.repeat(24)+'\nMeet; friends';
 const file=eventFile({id:'b'.repeat(32),title,place:'餐馆, 西岸',at:Date.UTC(2026,5,1)},new Date(2026,0,2));
 for (const l of file.split('\r\n'))assert.ok(Buffer.byteLength(l)<=75);
 const [event]=calendarPreview(file,Date.UTC(2026,0,2)).events;
 assert.equal(event.text,title);assert.equal(event.place,'餐馆, 西岸');
});
