import { google } from "googleapis";
import config from "../config.json" with { type: "json" };

// Google Calendar sync is optional. It's considered "enabled" only if:
//  - config.json has a google_calendar.calendar_id set, AND
//  - a service account key is provided via GOOGLE_SERVICE_ACCOUNT_JSON
//    (the full JSON key contents, as a single env var string) or
//    GOOGLE_SERVICE_ACCOUNT_KEY_FILE (a path to the JSON key file).
// If not configured, all functions below are safe no-ops so the rest of
// the app (SMS booking, admin calendar) works exactly as before.

const calendarId = config.google_calendar?.calendar_id || null;

let calendarClient = null;

function getClient() {
  if (!calendarId) return null;
  if (calendarClient) return calendarClient;

  let auth;
  try {
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ["https://www.googleapis.com/auth/calendar"],
      });
    } else if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
      auth = new google.auth.GoogleAuth({
        keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
        scopes: ["https://www.googleapis.com/auth/calendar"],
      });
    } else {
      return null; // no credentials configured
    }
  } catch (err) {
    console.error("[googleCalendar] Failed to load credentials:", err.message);
    return null;
  }

  calendarClient = google.calendar({ version: "v3", auth });
  return calendarClient;
}

export function isEnabled() {
  return Boolean(calendarId && getClient());
}

// Our appointment start/end times are stored as ISO strings representing
// the salon's local wall-clock time encoded with a "Z" suffix (see
// availability.js). Convert that into the {dateTime, timeZone} shape the
// Google Calendar API expects, using the wall-clock components as-is.
function toGoogleDateTime(isoString) {
  const d = new Date(isoString);
  const pad = (n) => String(n).padStart(2, "0");
  const dateTime =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return { dateTime, timeZone: config.timezone };
}

// Returns the salon timezone's UTC offset (in minutes, local = UTC + offset)
// for the instant `date` represents.
function tzOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  const asUTC = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day), hour, Number(map.minute), Number(map.second)
  );
  return (asUTC - date.getTime()) / 60000;
}

// Converts a "fake UTC" Date (wall-clock time in the salon's timezone,
// encoded with a Z suffix — see availability.js) into the real UTC instant.
function salonLocalToRealUTC(fakeUtcDate) {
  const offset = tzOffsetMinutes(fakeUtcDate);
  return new Date(fakeUtcDate.getTime() - offset * 60000);
}

// Converts a real UTC Date into a "fake UTC" Date whose fields match the
// salon's local wall-clock time, for consistency with availability.js.
function realUTCToSalonLocal(utcDate) {
  const offset = tzOffsetMinutes(utcDate);
  return new Date(utcDate.getTime() + offset * 60000);
}

// Returns busy intervals on the synced Google Calendar for the given salon-local
// date (YYYY-MM-DD), as { start, end } "fake UTC" ISO strings matching the
// convention used in availability.js. Returns [] if sync isn't enabled or on error.
export async function getBusyIntervals(dateStr) {
  const client = getClient();
  if (!client) return [];
  try {
    const dayStart = salonLocalToRealUTC(new Date(dateStr + "T00:00:00Z"));
    const dayEnd = salonLocalToRealUTC(new Date(dateStr + "T23:59:59Z"));
    const res = await client.freebusy.query({
      requestBody: {
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        items: [{ id: calendarId }],
      },
    });
    const busy = res.data.calendars?.[calendarId]?.busy || [];
    return busy.map((b) => ({
      start: realUTCToSalonLocal(new Date(b.start)).toISOString(),
      end: realUTCToSalonLocal(new Date(b.end)).toISOString(),
    }));
  } catch (err) {
    console.error("[googleCalendar] getBusyIntervals failed:", err.message);
    return [];
  }
}

function appointmentToEvent(appt) {
  return {
    summary: `${appt.service_name} — ${appt.customer_name || appt.customer_phone}`,
    description:
      `Customer: ${appt.customer_name || "(no name given)"}\n` +
      `Phone: ${appt.customer_phone}\n` +
      `Booked by: ${appt.created_by === "owner" ? "Owner" : "Agent"}`,
    location: config.address,
    start: toGoogleDateTime(appt.start_time),
    end: toGoogleDateTime(appt.end_time),
  };
}

// Creates a calendar event for the appointment. Returns the Google event id,
// or null if calendar sync isn't enabled or the request fails.
export async function createEvent(appt) {
  const client = getClient();
  if (!client) return null;
  try {
    const res = await client.events.insert({
      calendarId,
      requestBody: appointmentToEvent(appt),
    });
    return res.data.id || null;
  } catch (err) {
    console.error("[googleCalendar] createEvent failed:", err.message);
    return null;
  }
}

// Updates an existing event. No-op if calendar sync isn't enabled or
// eventId is missing.
export async function updateEvent(eventId, appt) {
  const client = getClient();
  if (!client || !eventId) return false;
  try {
    await client.events.update({
      calendarId,
      eventId,
      requestBody: appointmentToEvent(appt),
    });
    return true;
  } catch (err) {
    console.error("[googleCalendar] updateEvent failed:", err.message);
    return false;
  }
}

// Deletes an event (e.g. on cancellation). No-op if calendar sync isn't
// enabled or eventId is missing.
export async function deleteEvent(eventId) {
  const client = getClient();
  if (!client || !eventId) return false;
  try {
    await client.events.delete({ calendarId, eventId });
    return true;
  } catch (err) {
    // Treat "already gone" as success.
    if (err.code === 404 || err.code === 410) return true;
    console.error("[googleCalendar] deleteEvent failed:", err.message);
    return false;
  }
}
