import db from "../db.js";
import config from "../../config.json" with { type: "json" };
import { getOpenSlots, getNextAvailableSlot, getService, salonNow } from "../availability.js";
import { sendSms } from "../twilioClient.js";
import { createEvent, deleteEvent } from "../googleCalendar.js";

// Tool definitions sent to Claude
export const toolDefinitions = [
  {
    name: "check_availability",
    description:
      "Find open appointment slots for a given service on a given date. Date must be YYYY-MM-DD. Returns a list of available start times (ISO 8601, salon local time).",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string", description: "ID of the service, from the service list in the system prompt" },
        date: { type: "string", description: "Date to check, format YYYY-MM-DD" },
      },
      required: ["service_id", "date"],
    },
  },
  {
    name: "create_appointment",
    description:
      "Book an appointment for the customer. Only call this after the customer has confirmed the service, date, and time.",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string" },
        start_time: { type: "string", description: "ISO 8601 start time, salon local time" },
        customer_name: { type: "string", description: "Customer's name, if known" },
      },
      required: ["service_id", "start_time"],
    },
  },
  {
    name: "cancel_appointment",
    description: "Cancel an existing appointment for this customer.",
    input_schema: {
      type: "object",
      properties: {
        appointment_id: { type: "integer", description: "ID of the appointment to cancel" },
      },
      required: ["appointment_id"],
    },
  },
  {
    name: "list_my_appointments",
    description: "List this customer's upcoming confirmed appointments.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "notify_owner",
    description:
      "Escalate to the salon owner/human staff. Use for complaints, refunds, injuries, explicit requests to speak to a person, or anything outside policy. After calling this, stop trying to resolve the issue yourself.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Short reason for the escalation" },
        summary: { type: "string", description: "Summary of the customer's message/situation for the owner" },
      },
      required: ["reason", "summary"],
    },
  },
];

// Tool implementations. Each returns a JSON-serializable result.
export async function runTool(name, input, ctx) {
  switch (name) {
    case "check_availability":
      return checkAvailability(input);
    case "create_appointment":
      return createAppointment(input, ctx);
    case "cancel_appointment":
      return cancelAppointment(input, ctx);
    case "list_my_appointments":
      return listMyAppointments(ctx);
    case "notify_owner":
      return notifyOwner(input, ctx);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function checkAvailability({ service_id, date }) {
  const service = getService(service_id);
  if (!service) return { error: `Unknown service_id: ${service_id}` };

  const maxDate = salonNow();
  maxDate.setUTCDate(maxDate.getUTCDate() + config.booking.max_days_ahead);
  const requested = new Date(date + "T00:00:00Z");
  if (requested > maxDate) {
    return { error: `We only take bookings up to ${config.booking.max_days_ahead} days in advance.` };
  }

  const slots = getOpenSlots(date, service.duration_min);

  let next_available = undefined;
  if (slots.length === 0) {
    // Look for the closest open slot on this day or any of the following days.
    const next = getNextAvailableSlot(service.duration_min, date, config.booking.max_days_ahead);
    next_available = next ? next.start : null;
  }

  return {
    service: service.name,
    date,
    available_start_times: slots.map((s) => s.start),
    note: slots.length === 0 ? "No open slots that day for this service." : undefined,
    next_available,
  };
}

async function createAppointment({ service_id, start_time, customer_name }, ctx) {
  const service = getService(service_id);
  if (!service) return { error: `Unknown service_id: ${service_id}` };

  const start = new Date(start_time);
  if (isNaN(start.getTime())) return { error: "Invalid start_time" };
  const end = new Date(start.getTime() + service.duration_min * 60000);

  // Double-check the slot is still free
  const conflict = db
    .prepare(
      `SELECT id FROM appointments WHERE status = 'confirmed'
       AND start_time < ? AND end_time > ?`
    )
    .get(end.toISOString(), start.toISOString());
  if (conflict) {
    return { error: "That slot was just booked by someone else. Please choose another time." };
  }

  const result = db
    .prepare(
      `INSERT INTO appointments (customer_phone, customer_name, service_id, service_name, start_time, end_time, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 'agent')`
    )
    .run(ctx.customerPhone, customer_name || null, service.id, service.name, start.toISOString(), end.toISOString());

  const appointment_id = result.lastInsertRowid;

  // Best-effort sync to Google Calendar, if configured.
  const eventId = await createEvent({
    customer_phone: ctx.customerPhone,
    customer_name: customer_name || null,
    service_name: service.name,
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    created_by: "agent",
  });
  if (eventId) {
    db.prepare(`UPDATE appointments SET google_event_id = ? WHERE id = ?`).run(eventId, appointment_id);
  }

  return {
    success: true,
    appointment_id,
    service: service.name,
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    price: service.price,
  };
}

async function cancelAppointment({ appointment_id }, ctx) {
  const appt = db
    .prepare(`SELECT * FROM appointments WHERE id = ? AND customer_phone = ?`)
    .get(appointment_id, ctx.customerPhone);
  if (!appt) return { error: "Appointment not found for this phone number." };
  if (appt.status === "cancelled") return { error: "This appointment is already cancelled." };

  db.prepare(`UPDATE appointments SET status = 'cancelled' WHERE id = ?`).run(appointment_id);
  if (appt.google_event_id) await deleteEvent(appt.google_event_id);
  return { success: true, appointment_id, cancelled_service: appt.service_name, cancelled_start: appt.start_time };
}

function listMyAppointments(ctx) {
  const rows = db
    .prepare(
      `SELECT id, service_name, start_time, end_time FROM appointments
       WHERE customer_phone = ? AND status = 'confirmed' AND start_time > datetime('now')
       ORDER BY start_time ASC`
    )
    .all(ctx.customerPhone);
  return { appointments: rows };
}

async function notifyOwner({ reason, summary }, ctx) {
  // Mark this conversation as paused so the agent stops auto-replying.
  db.prepare(
    `INSERT INTO conversation_state (customer_phone, agent_paused)
     VALUES (?, 1)
     ON CONFLICT(customer_phone) DO UPDATE SET agent_paused = 1`
  ).run(ctx.customerPhone);

  const ownerMessage =
    `[${config.name}] Heads up — a customer conversation needs you.\n` +
    `Customer: ${ctx.customerPhone}\n` +
    `Reason: ${reason}\n` +
    `Summary: ${summary}\n` +
    `The agent has paused replies to this customer. Open the admin page to reply ` +
    `or resume the agent.`;

  await sendSms(config.handoff.owner_phone, ownerMessage);

  return {
    success: true,
    note: "Owner has been notified and will follow up with the customer directly.",
  };
}
