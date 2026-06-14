import express from "express";
import db from "./db.js";
import config from "../config.json" with { type: "json" };
import { sendSms } from "./twilioClient.js";
import { getService } from "./availability.js";
import { createEvent, updateEvent, deleteEvent } from "./googleCalendar.js";

export const adminRouter = express.Router();

// --- Basic auth (username "admin", password from ADMIN_PASSWORD env var) ---
adminRouter.use((req, res, next) => {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    return res.status(500).send("ADMIN_PASSWORD is not set in .env — admin page disabled.");
  }
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="admin"');
    return res.status(401).send("Authentication required");
  }
  const decoded = Buffer.from(auth.slice(6), "base64").toString();
  const [user, pass] = decoded.split(":");
  if (user !== "admin" || pass !== password) {
    res.set("WWW-Authenticate", 'Basic realm="admin"');
    return res.status(401).send("Invalid credentials");
  }
  next();
});

// --- JSON APIs ---

// Returns confirmed appointments. Optionally filter by ?from=ISO&to=ISO (for calendar views).
// Without range params, defaults to upcoming appointments (old behavior).
adminRouter.get("/api/appointments", (req, res) => {
  const { from, to } = req.query;
  let rows;
  if (from && to) {
    rows = db
      .prepare(
        `SELECT * FROM appointments
         WHERE status = 'confirmed' AND start_time >= ? AND start_time < ?
         ORDER BY start_time ASC LIMIT 500`
      )
      .all(from, to);
  } else {
    rows = db
      .prepare(
        `SELECT * FROM appointments
         WHERE status = 'confirmed' AND start_time > datetime('now', '-1 day')
         ORDER BY start_time ASC LIMIT 100`
      )
      .all();
  }
  res.json(rows);
});

// List of services (for the owner's add/edit appointment form)
adminRouter.get("/api/services", (req, res) => {
  res.json(config.services);
});

// Owner creates a new appointment manually
adminRouter.post("/api/appointments", express.json(), async (req, res) => {
  const { customer_name, customer_phone, service_id, start_time } = req.body || {};
  if (!customer_phone || !service_id || !start_time) {
    return res.status(400).json({ error: "customer_phone, service_id, and start_time are required" });
  }
  const service = getService(service_id);
  if (!service) return res.status(400).json({ error: `Unknown service_id: ${service_id}` });

  const start = new Date(start_time);
  if (isNaN(start.getTime())) return res.status(400).json({ error: "Invalid start_time" });
  const end = new Date(start.getTime() + service.duration_min * 60000);

  const conflict = db
    .prepare(
      `SELECT id FROM appointments WHERE status = 'confirmed'
       AND start_time < ? AND end_time > ?`
    )
    .get(end.toISOString(), start.toISOString());
  if (conflict) return res.status(409).json({ error: "That time conflicts with an existing appointment." });

  const result = db
    .prepare(
      `INSERT INTO appointments (customer_phone, customer_name, service_id, service_name, start_time, end_time, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 'owner')`
    )
    .run(customer_phone, customer_name || null, service.id, service.name, start.toISOString(), end.toISOString());

  const appointment_id = result.lastInsertRowid;

  const eventId = await createEvent({
    customer_phone,
    customer_name: customer_name || null,
    service_name: service.name,
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    created_by: "owner",
  });
  if (eventId) {
    db.prepare(`UPDATE appointments SET google_event_id = ? WHERE id = ?`).run(eventId, appointment_id);
  }

  res.json({ success: true, appointment_id });
});

// Owner edits/reschedules an existing appointment
adminRouter.put("/api/appointments/:id", express.json(), async (req, res) => {
  const id = req.params.id;
  const appt = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(id);
  if (!appt) return res.status(404).json({ error: "Appointment not found" });

  const customer_name = req.body?.customer_name ?? appt.customer_name;
  const customer_phone = req.body?.customer_phone ?? appt.customer_phone;
  const service_id = req.body?.service_id ?? appt.service_id;
  const start_time = req.body?.start_time ?? appt.start_time;

  const service = getService(service_id);
  if (!service) return res.status(400).json({ error: `Unknown service_id: ${service_id}` });

  const start = new Date(start_time);
  if (isNaN(start.getTime())) return res.status(400).json({ error: "Invalid start_time" });
  const end = new Date(start.getTime() + service.duration_min * 60000);

  const conflict = db
    .prepare(
      `SELECT id FROM appointments WHERE status = 'confirmed' AND id != ?
       AND start_time < ? AND end_time > ?`
    )
    .get(id, end.toISOString(), start.toISOString());
  if (conflict) return res.status(409).json({ error: "That time conflicts with another appointment." });

  db.prepare(
    `UPDATE appointments
     SET customer_name = ?, customer_phone = ?, service_id = ?, service_name = ?, start_time = ?, end_time = ?
     WHERE id = ?`
  ).run(customer_name || null, customer_phone, service.id, service.name, start.toISOString(), end.toISOString(), id);

  const updatedAppt = {
    customer_phone,
    customer_name: customer_name || null,
    service_name: service.name,
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    created_by: appt.created_by,
  };

  if (appt.google_event_id) {
    await updateEvent(appt.google_event_id, updatedAppt);
  } else {
    const eventId = await createEvent(updatedAppt);
    if (eventId) db.prepare(`UPDATE appointments SET google_event_id = ? WHERE id = ?`).run(eventId, id);
  }

  res.json({ success: true });
});

adminRouter.get("/api/conversations", (req, res) => {
  // All customers with any messages, most recently active first, with pause state
  const rows = db
    .prepare(
      `SELECT m.customer_phone,
              MAX(m.created_at) as last_message_at,
              COALESCE(cs.agent_paused, 0) as agent_paused
       FROM messages m
       LEFT JOIN conversation_state cs ON cs.customer_phone = m.customer_phone
       GROUP BY m.customer_phone
       ORDER BY last_message_at DESC
       LIMIT 50`
    )
    .all();
  res.json(rows);
});

adminRouter.get("/api/messages", (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: "phone query param required" });
  const rows = db
    .prepare(
      `SELECT direction, sent_by, body, created_at FROM messages
       WHERE customer_phone = ? ORDER BY created_at ASC LIMIT 200`
    )
    .all(phone);
  res.json(rows);
});

// Owner sends a manual reply to a customer (also pauses the agent for that thread)
adminRouter.post("/api/reply", express.json(), async (req, res) => {
  const { phone, message } = req.body || {};
  if (!phone || !message) return res.status(400).json({ error: "phone and message required" });

  try {
    await sendSms(phone, message);
  } catch (err) {
    return res.status(500).json({ error: "Failed to send SMS: " + err.message });
  }

  db.prepare(
    `INSERT INTO messages (customer_phone, direction, sent_by, body) VALUES (?, 'outbound', 'owner', ?)`
  ).run(phone, message);

  db.prepare(
    `INSERT INTO conversation_state (customer_phone, agent_paused)
     VALUES (?, 1)
     ON CONFLICT(customer_phone) DO UPDATE SET agent_paused = 1`
  ).run(phone);

  res.json({ success: true });
});

// Resume the agent for a customer (un-pause)
adminRouter.post("/api/resume", express.json(), (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone required" });

  db.prepare(
    `INSERT INTO conversation_state (customer_phone, agent_paused)
     VALUES (?, 0)
     ON CONFLICT(customer_phone) DO UPDATE SET agent_paused = 0`
  ).run(phone);

  res.json({ success: true });
});

// Cancel an appointment (admin override, no phone check)
adminRouter.post("/api/cancel", express.json(), async (req, res) => {
  const { appointment_id } = req.body || {};
  if (!appointment_id) return res.status(400).json({ error: "appointment_id required" });

  const appt = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(appointment_id);
  if (!appt) return res.status(404).json({ error: "Appointment not found" });

  db.prepare(`UPDATE appointments SET status = 'cancelled' WHERE id = ?`).run(appointment_id);
  if (appt.google_event_id) await deleteEvent(appt.google_event_id);
  res.json({ success: true });
});

// --- Simple HTML page ---
adminRouter.get("/", (req, res) => {
  res.type("html").send(ADMIN_HTML.replaceAll("__SALON_NAME__", config.name).replaceAll("__SALON_TZ__", config.timezone));
});

const ADMIN_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>__SALON_NAME__ — Agent Admin</title>
  <style>
    body { font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 980px; margin: 20px auto; padding: 0 16px; color: #222; }
    h1 { font-size: 20px; }
    h2 { font-size: 16px; margin-top: 32px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; }
    .badge.paused { background: #fde2e2; color: #a33; }
    .badge.active { background: #e2f5e2; color: #2a7; }
    .badge.agent { background: #e2ecfd; color: #2563eb; }
    .badge.owner { background: #fdf0d5; color: #b45309; }
    button { font-size: 13px; padding: 4px 10px; cursor: pointer; }
    .conv { margin-top: 8px; }
    .messages { max-height: 300px; overflow-y: auto; border: 1px solid #eee; padding: 8px; font-size: 13px; background: #fafafa; margin: 8px 0; }
    .msg { margin: 4px 0; }
    .msg.customer { color: #222; }
    .msg.agent { color: #06c; }
    .msg.owner { color: #a60; }
    textarea { width: 100%; box-sizing: border-box; font-size: 14px; padding: 6px; }
    .row { display: flex; gap: 8px; align-items: center; }

    /* Calendar */
    .cal-header { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
    .cal-header h2 { border: none; margin: 0; flex: 1; }
    .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; margin-top: 8px; }
    .cal-dow { font-size: 12px; font-weight: 600; color: #888; text-align: center; padding: 4px 0; }
    .cal-cell { border: 1px solid #eee; border-radius: 6px; min-height: 90px; padding: 4px; font-size: 12px; background: #fff; }
    .cal-cell.other-month { background: #fafafa; color: #bbb; }
    .cal-cell.today { border-color: #2563eb; }
    .cal-date { font-weight: 600; margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; }
    .cal-date .add-btn { font-size: 11px; padding: 1px 6px; }
    .cal-appt { display: block; width: 100%; text-align: left; border-radius: 4px; padding: 2px 4px; margin-bottom: 2px; font-size: 11px; border: none; cursor: pointer; line-height: 1.3; }
    .cal-appt.agent { background: #e2ecfd; color: #2563eb; }
    .cal-appt.owner { background: #fdf0d5; color: #b45309; }
    .cal-appt.cancelled { text-decoration: line-through; opacity: 0.5; }

    /* Modal */
    .modal-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.4); align-items: center; justify-content: center; }
    .modal-backdrop.open { display: flex; }
    .modal { background: #fff; border-radius: 8px; padding: 20px; width: 360px; max-width: 90vw; }
    .modal h3 { margin-top: 0; font-size: 16px; }
    .modal label { display: block; font-size: 12px; color: #555; margin-top: 10px; margin-bottom: 2px; }
    .modal input, .modal select { width: 100%; box-sizing: border-box; font-size: 14px; padding: 6px; border: 1px solid #ccc; border-radius: 4px; }
    .modal-actions { display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end; }
    .modal-error { color: #c33; font-size: 12px; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>__SALON_NAME__ — Agent Admin</h1>

  <div class="cal-header">
    <button id="cal-prev">&larr;</button>
    <h2 id="cal-title"></h2>
    <button id="cal-next">&rarr;</button>
    <button id="cal-add">+ Add appointment</button>
  </div>
  <div class="cal-grid" id="cal-grid"></div>

  <h2>Conversations</h2>
  <div id="conversations"></div>

  <div class="modal-backdrop" id="modal-backdrop">
    <div class="modal">
      <h3 id="modal-title">Appointment</h3>
      <label>Customer name</label>
      <input id="m-name" type="text" placeholder="Customer name" />
      <label>Phone number</label>
      <input id="m-phone" type="text" placeholder="+15551234567" />
      <label>Service</label>
      <select id="m-service"></select>
      <label>Date</label>
      <input id="m-date" type="date" />
      <label>Time</label>
      <input id="m-time" type="time" />
      <div class="modal-error" id="m-error" style="display:none;"></div>
      <div class="modal-actions">
        <button id="m-cancel-appt" style="display:none; margin-right:auto; background:#fde2e2; border:1px solid #f3b4b4;">Cancel appointment</button>
        <button id="m-close">Close</button>
        <button id="m-save">Save</button>
      </div>
    </div>
  </div>

<script>
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function fmt(iso) {
  return new Date(iso).toLocaleString();
}

// --- Calendar ---
const SALON_TZ = '__SALON_TZ__';

// Appointment start_time values are ISO strings representing the salon's
// local wall-clock time, encoded as if it were UTC (e.g. "11:00" PT is
// stored as "...T11:00:00.000Z"). So we read/write them with the UTC
// getters/setters below, never the local-timezone ones, to avoid the
// browser's own timezone shifting the displayed time.
function salonNowDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SALON_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date());
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  return new Date(Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), hour, Number(map.minute), Number(map.second)));
}

let calMonth = salonNowDate();
calMonth.setUTCDate(1);
calMonth.setUTCHours(0,0,0,0);
let services = [];
let editingId = null;

function pad(n) { return String(n).padStart(2, '0'); }
function toDateStr(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth()+1) + '-' + pad(d.getUTCDate()); }
function toTimeStr(d) { return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); }

async function loadServices() {
  services = await api('/admin/api/services');
  const sel = document.getElementById('m-service');
  sel.innerHTML = services.map(s => \`<option value="\${s.id}">\${s.name} ($\${s.price})</option>\`).join('');
}

async function renderCalendar() {
  const grid = document.getElementById('cal-grid');
  const title = document.getElementById('cal-title');
  title.textContent = calMonth.toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const firstOfMonth = new Date(calMonth);
  const startDow = firstOfMonth.getUTCDay();
  const gridStart = new Date(firstOfMonth);
  gridStart.setUTCDate(gridStart.getUTCDate() - startDow);

  const gridEnd = new Date(gridStart);
  gridEnd.setUTCDate(gridEnd.getUTCDate() + 42); // 6 weeks

  const appts = await api('/admin/api/appointments?from=' + gridStart.toISOString() + '&to=' + gridEnd.toISOString());
  const byDay = {};
  for (const a of appts) {
    const key = toDateStr(new Date(a.start_time));
    (byDay[key] = byDay[key] || []).push(a);
  }

  grid.innerHTML = '';
  const dows = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  for (const d of dows) {
    const el = document.createElement('div');
    el.className = 'cal-dow';
    el.textContent = d;
    grid.appendChild(el);
  }

  const today = toDateStr(salonNowDate());
  for (let i = 0; i < 42; i++) {
    const day = new Date(gridStart);
    day.setUTCDate(day.getUTCDate() + i);
    const dateStr = toDateStr(day);
    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    if (day.getUTCMonth() !== calMonth.getUTCMonth()) cell.classList.add('other-month');
    if (dateStr === today) cell.classList.add('today');

    const dateRow = document.createElement('div');
    dateRow.className = 'cal-date';
    dateRow.innerHTML = '<span>' + day.getUTCDate() + '</span>';
    const addBtn = document.createElement('button');
    addBtn.className = 'add-btn';
    addBtn.textContent = '+';
    addBtn.title = 'Add appointment';
    addBtn.onclick = () => openModal(null, dateStr);
    dateRow.appendChild(addBtn);
    cell.appendChild(dateRow);

    for (const a of (byDay[dateStr] || [])) {
      const btn = document.createElement('button');
      const start = new Date(a.start_time);
      btn.className = 'cal-appt ' + (a.created_by === 'owner' ? 'owner' : 'agent');
      btn.textContent = toTimeStr(start) + ' ' + (a.customer_name || a.customer_phone) + ' — ' + a.service_name +
        ' (' + (a.created_by === 'owner' ? 'Owner' : 'Agent') + ')';
      btn.onclick = () => openModal(a);
      cell.appendChild(btn);
    }

    grid.appendChild(cell);
  }
}

// --- Modal ---
function openModal(appt, defaultDate) {
  editingId = appt ? appt.id : null;
  document.getElementById('modal-title').textContent = appt ? 'Edit appointment' : 'New appointment';
  document.getElementById('m-error').style.display = 'none';
  document.getElementById('m-name').value = appt ? (appt.customer_name || '') : '';
  document.getElementById('m-phone').value = appt ? appt.customer_phone : '';
  document.getElementById('m-service').value = appt ? appt.service_id : (services[0] && services[0].id);
  if (appt) {
    const start = new Date(appt.start_time);
    document.getElementById('m-date').value = toDateStr(start);
    document.getElementById('m-time').value = toTimeStr(start);
  } else {
    document.getElementById('m-date').value = defaultDate || toDateStr(salonNowDate());
    document.getElementById('m-time').value = '10:00';
  }
  document.getElementById('m-cancel-appt').style.display = appt ? 'inline-block' : 'none';
  document.getElementById('modal-backdrop').classList.add('open');
}

function closeModal() {
  document.getElementById('modal-backdrop').classList.remove('open');
  editingId = null;
}

async function saveAppointment() {
  const errEl = document.getElementById('m-error');
  errEl.style.display = 'none';

  const customer_name = document.getElementById('m-name').value.trim();
  const customer_phone = document.getElementById('m-phone').value.trim();
  const service_id = document.getElementById('m-service').value;
  const date = document.getElementById('m-date').value;
  const time = document.getElementById('m-time').value;

  if (!customer_phone || !date || !time) {
    errEl.textContent = 'Phone, date, and time are required.';
    errEl.style.display = 'block';
    return;
  }

  const start_time = new Date(date + 'T' + time + ':00Z').toISOString();
  const payload = { customer_name, customer_phone, service_id, start_time };

  try {
    if (editingId) {
      await api('/admin/api/appointments/' + editingId, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    } else {
      await api('/admin/api/appointments', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    }
    closeModal();
    renderCalendar();
  } catch (e) {
    let msg = e.message;
    try { msg = JSON.parse(msg).error || msg; } catch {}
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }
}

async function cancelAppointmentFromModal() {
  if (!editingId) return;
  if (!confirm('Cancel this appointment?')) return;
  await api('/admin/api/cancel', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ appointment_id: editingId }) });
  closeModal();
  renderCalendar();
}

document.getElementById('cal-prev').onclick = () => { calMonth.setUTCMonth(calMonth.getUTCMonth() - 1); renderCalendar(); };
document.getElementById('cal-next').onclick = () => { calMonth.setUTCMonth(calMonth.getUTCMonth() + 1); renderCalendar(); };
document.getElementById('cal-add').onclick = () => openModal(null, toDateStr(salonNowDate()));
document.getElementById('m-close').onclick = closeModal;
document.getElementById('m-save').onclick = saveAppointment;
document.getElementById('m-cancel-appt').onclick = cancelAppointmentFromModal;
document.getElementById('modal-backdrop').onclick = (e) => { if (e.target.id === 'modal-backdrop') closeModal(); };

async function loadConversations() {
  const convos = await api('/admin/api/conversations');
  const container = document.getElementById('conversations');
  container.innerHTML = '';
  for (const c of convos) {
    const div = document.createElement('div');
    div.className = 'conv';
    div.innerHTML = \`
      <div class="row">
        <strong>\${c.customer_phone}</strong>
        <span class="badge \${c.agent_paused ? 'paused' : 'active'}">\${c.agent_paused ? 'PAUSED (human)' : 'agent active'}</span>
        <span style="color:#999; font-size:12px;">last: \${fmt(c.last_message_at)}</span>
        \${c.agent_paused ? '<button class="resume">Resume agent</button>' : ''}
        <button class="toggle">Show messages</button>
      </div>
      <div class="messages" style="display:none;"></div>
      <div class="row" style="display:none;" data-reply-row>
        <textarea rows="2" placeholder="Reply as owner..."></textarea>
        <button class="send">Send</button>
      </div>
    \`;
    const msgDiv = div.querySelector('.messages');
    const replyRow = div.querySelector('[data-reply-row]');
    div.querySelector('.toggle').onclick = async () => {
      const showing = msgDiv.style.display !== 'none';
      if (showing) { msgDiv.style.display = 'none'; replyRow.style.display = 'none'; return; }
      const msgs = await api('/admin/api/messages?phone=' + encodeURIComponent(c.customer_phone));
      msgDiv.innerHTML = msgs.map(m => \`<div class="msg \${m.sent_by}"><b>\${m.sent_by}:</b> \${m.body}</div>\`).join('');
      msgDiv.style.display = 'block';
      replyRow.style.display = 'flex';
      msgDiv.scrollTop = msgDiv.scrollHeight;
    };
    div.querySelector('.send').onclick = async () => {
      const textarea = div.querySelector('textarea');
      if (!textarea.value.trim()) return;
      await api('/admin/api/reply', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ phone: c.customer_phone, message: textarea.value }) });
      textarea.value = '';
      loadConversations();
    };
    const resumeBtn = div.querySelector('.resume');
    if (resumeBtn) {
      resumeBtn.onclick = async () => {
        await api('/admin/api/resume', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ phone: c.customer_phone }) });
        loadConversations();
      };
    }
    container.appendChild(div);
  }
}

loadServices().then(renderCalendar);
loadConversations();
setInterval(() => { renderCalendar(); loadConversations(); }, 15000);
</script>
</body>
</html>`;
