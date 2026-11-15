// The local wall clock of an instant in an IANA zone (the system zone by default, so `TZ` is honoured, Windows included), and the
// 5-minute grid the printed finish ends sit on. Used by report.mjs.
// Exports: clockText(ms, zone) -> 'HH:MM'; dayText(ms, zone) -> 'Sun 15 Nov'; localDate(ms, zone); offsetText(ms, zone) -> '+03:30';
// gridded(ms, zone, up) -> epoch ms on the grid; systemTimeZone(); CLOCK_STEP_MS.
// Invariants: pure apart from reading the system time zone; no I/O.
const MINUTE_MS = 60_000;
const SECOND_MS = 1000;
const MINUTES_PER_HOUR = 60;
export const CLOCK_STEP_MS = 5 * MINUTE_MS; // finish ends are rounded to 5 minutes: finer would claim a precision the data does not have
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WALL_FIELDS = { hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' };
const pad = (value) => String(value).padStart(2, '0');
export const systemTimeZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The wall clock of an instant in a zone: numeric fields, the short weekday, and the zone's offset from UTC in ms. */
function wallClock(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { ...WALL_FIELDS, timeZone }).formatToParts(new Date(ms));
  const field = (type) => parts.find((part) => part.type === type).value;
  const [year, month, day, hour, minute, second] = ['year', 'month', 'day', 'hour', 'minute', 'second'].map((type) => Number(field(type)));
  const offsetMs = Date.UTC(year, month - 1, day, hour, minute, second) - Math.floor(ms / SECOND_MS) * SECOND_MS;
  return { year, month, day, hour, minute, weekday: field('weekday'), offsetMs };
}

export const clockText = (ms, timeZone) => {
  const wall = wallClock(ms, timeZone);
  return `${pad(wall.hour)}:${pad(wall.minute)}`;
};
export const dayText = (ms, timeZone) => {
  const wall = wallClock(ms, timeZone);
  return `${wall.weekday} ${wall.day} ${MONTHS[wall.month - 1]}`;
};
export const localDate = (ms, timeZone) => {
  const wall = wallClock(ms, timeZone);
  return `${wall.year}-${wall.month}-${wall.day}`;
};

/** The zone's offset at an instant as `+03:30` / `-05:00` / `+00:00`. */
export function offsetText(ms, timeZone) {
  const minutes = Math.round(wallClock(ms, timeZone).offsetMs / MINUTE_MS);
  const sign = minutes < 0 ? '-' : '+';
  return `${sign}${pad(Math.floor(Math.abs(minutes) / MINUTES_PER_HOUR))}:${pad(Math.abs(minutes) % MINUTES_PER_HOUR)}`;
}

/** An instant rounded down (or up) to CLOCK_STEP_MS on the zone's local clock. */
export function gridded(ms, timeZone, up) {
  const { offsetMs } = wallClock(ms, timeZone);
  const steps = (ms + offsetMs) / CLOCK_STEP_MS;
  return (up ? Math.ceil(steps) : Math.floor(steps)) * CLOCK_STEP_MS - offsetMs;
}
