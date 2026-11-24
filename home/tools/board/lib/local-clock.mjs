// The local wall clock of an instant in an IANA zone (the system zone by default, so `TZ` is honoured, Windows included), for the
// status line's reset clocks (cells.mjs) and its time zone (statusline.mjs).
// Exports: clockText(ms, zone) -> 'HH:MM'; dayText(ms, zone) -> 'Sun 15 Nov'; localDate(ms, zone) -> a day key such as '2026-1-5'; systemTimeZone().
// Invariants: pure apart from reading the system time zone; no I/O.
const SECOND_MS = 1000;
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
