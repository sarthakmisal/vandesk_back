'use strict';
/** Business dates and times are Indian Standard Time (Asia/Kolkata); instants are stored in UTC. */
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** @returns {{date:string,time:string,period:string,day:number,hour:number}} */
function ist(d) {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    period: `${p.year}-${p.month}`,
    day: Number(p.day),
    hour: Number(p.hour),
  };
}

const istTime = (d) => (d ? ist(new Date(d)).time : undefined);
/** Morning = pickup, afternoon = drop. */
const defaultDirection = (d) => (ist(d).hour < 12 ? 'pickup' : 'drop');
/** '2026-09' -> '2026-09-01' */
const monthStart = (period) => `${period}-01`;

module.exports = { ist, istTime, defaultDirection, monthStart };
