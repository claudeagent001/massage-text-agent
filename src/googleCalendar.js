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
