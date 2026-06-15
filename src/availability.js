import db from "./db.js";
import config from "../config.json" with { type: "json" };
import { getBusyIntervals } from "./googleCalendar.js";

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// Parse "10:00-20:00" -> { openMin, closeMin } in minutes from midnight
function parseHours(rangeStr) {
  if (!rangeStr || rangeStr === "closed") return null;
  const [open, close] = rangeStr.split("-");
  const toMin = (t) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };
  return { openMin: toMin(open), closeMin: toMin(close) };
}

// Returns the current moment, expressed as a "fake UTC" Date whose
// year/month/day/hour/minute/second match the wall-clock time in the
// salon's configured timezone. This lets us compare directly against
// slot times below, which are constructed the same way (via "...T..Z"),
// regardless of what timezone the server process itself runs in.
export function salonNow() {
  const tz = config.timezone;
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  let hour = Number(map.hour);
  if (hour === 24) hour = 0; // some locales report midnight as "24"
  return new Date(
    Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), hour, Number(map.minute), Number(map.second))
  );
}

// Returns array of { start, end } ISO strings for open slots on a given date
// that can fit `durationMin`. `dateStr` is YYYY-MM-DD in the salon's local time.
export async function getOpenSlots(dateStr, durationMin) {
  // Treat the date as midnight in the salon's timezone, represented as a
  // "fake UTC" Date (see salonNow above) so all arithmetic stays consistent.
  const date = new Date(dateStr + "T00:00:00Z");
  const dayKey = DAY_KEYS[date.getUTCDay()];
  const hours = parseHours(config.hours[dayKey]);
  if (!hours) return []; // closed

  const increment = config.booking.slot_increment_min;
  const slots = [];

  for (let m = hours.openMin; m + durationMin <= hours.closeMin; m += increment) {
    const slotStart = new Date(date);
    slotStart.setUTCMinutes(m);
    const slotEnd = new Date(slotStart.getTime() + durationMin * 60000);
    slots.push({ start: slotStart, end: slotEnd });
  }

  // Remove slots that overlap existing confirmed appointments
  const dayStart = new Date(dateStr + "T00:00:00Z").toISOString();
  const dayEnd = new Date(dateStr + "T23:59:59Z").toISOString();
  const existing = db
    .prepare(
      `SELECT start_time, end_time FROM appointments
       WHERE status = 'confirmed' AND start_time >= ? AND start_time <= ?`
    )
    .all(dayStart, dayEnd);

  const busy = existing.map((a) => ({
    start: new Date(a.start_time),
    end: new Date(a.end_time),
  }));

  // Also block out anything busy on the synced Google Calendar (e.g. manually
  // added events), so the agent never offers a slot that's already taken there.
  const calendarBusy = await getBusyIntervals(dateStr);
  for (const b of calendarBusy) {
    busy.push({ start: new Date(b.start), end: new Date(b.end) });
  }

  const free = slots.filter((slot) => {
    return !busy.some((b) => slot.start < b.end && slot.end > b.start);
  });

  // Don't offer slots in the past for today (compared in salon-local time)
  const now = salonNow();
  return free
    .filter((s) => s.start > now)
    .map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() }));
}

export function getService(serviceId) {
  return config.services.find((s) => s.id === serviceId);
}

// Searches forward from `fromDateStr` (YYYY-MM-DD, inclusive) for the next
// open slot that fits `durationMin`, looking up to `maxDaysAhead` days.
// Returns { start, end } (ISO strings) or null if nothing is found.
export async function getNextAvailableSlot(durationMin, fromDateStr, maxDaysAhead) {
  const start = new Date(fromDateStr + "T00:00:00Z");
  for (let i = 0; i <= maxDaysAhead; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const slots = await getOpenSlots(dateStr, durationMin);
    if (slots.length > 0) return slots[0];
  }
  return null;
}
