import db from "./db.js";
import config from "../config.json" with { type: "json" };

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

function toMinutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// Returns array of { start, end } ISO strings for open slots on a given date
// that can fit `durationMin`.
export function getOpenSlots(dateStr, durationMin) {
  const date = new Date(dateStr + "T00:00:00");
  const dayKey = DAY_KEYS[date.getDay()];
  const hours = parseHours(config.hours[dayKey]);
  if (!hours) return []; // closed

  const increment = config.booking.slot_increment_min;
  const slots = [];

  for (let m = hours.openMin; m + durationMin <= hours.closeMin; m += increment) {
    const slotStart = new Date(date);
    slotStart.setMinutes(m);
    const slotEnd = new Date(slotStart.getTime() + durationMin * 60000);
    slots.push({ start: slotStart, end: slotEnd });
  }

  // Remove slots that overlap existing confirmed appointments
  const dayStart = new Date(dateStr + "T00:00:00").toISOString();
  const dayEnd = new Date(dateStr + "T23:59:59").toISOString();
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

  const free = slots.filter((slot) => {
    return !busy.some((b) => slot.start < b.end && slot.end > b.start);
  });

  // Don't offer slots in the past for today
  const now = new Date();
  return free
    .filter((s) => s.start > now)
    .map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() }));
}

export function getService(serviceId) {
  return config.services.find((s) => s.id === serviceId);
}
