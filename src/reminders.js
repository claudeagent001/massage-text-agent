// Sends reminder SMS for upcoming appointments.
// Run this on a schedule (e.g. cron every 15 min):
//   */15 * * * * cd /path/to/massage-text-agent && node src/reminders.js >> reminders.log 2>&1
import "dotenv/config";
import db from "./db.js";
import config from "../config.json" with { type: "json" };
import { sendSms } from "./twilioClient.js";

const windowHours = config.booking.reminder_hours_before;

function formatTime(iso) {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: config.timezone,
  });
}

async function run() {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + windowHours * 60 * 60 * 1000);

  const due = db
    .prepare(
      `SELECT * FROM appointments
       WHERE status = 'confirmed' AND reminder_sent = 0
       AND start_time > ? AND start_time <= ?`
    )
    .all(now.toISOString(), windowEnd.toISOString());

  if (due.length === 0) {
    console.log(`[reminders] nothing due (${now.toISOString()})`);
    return;
  }

  for (const appt of due) {
    const message =
      `Reminder: your ${appt.service_name} at ${config.name} is on ` +
      `${formatTime(appt.start_time)}. ${config.policies.cancellation} ` +
      `Reply here if you need to reschedule.`;

    try {
      await sendSms(appt.customer_phone, message);
      db.prepare(`UPDATE appointments SET reminder_sent = 1 WHERE id = ?`).run(appt.id);
      console.log(`[reminders] sent to ${appt.customer_phone} for appointment #${appt.id}`);
    } catch (err) {
      console.error(`[reminders] failed for appointment #${appt.id}:`, err.message);
    }
  }
}

run().then(() => process.exit(0));
