import express from "express";
import db from "./db.js";
import config from "../config.json" with { type: "json" };
import { sendSms } from "./twilioClient.js";

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

adminRouter.get("/api/appointments", (req, res) => {
  const rows = db
    .prepare(
      `SELECT * FROM appointments
       WHERE status = 'confirmed' AND start_time > datetime('now', '-1 day')
       ORDER BY start_time ASC LIMIT 100`
    )
    .all();
  res.json(rows);
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
adminRouter.post("/api/cancel", express.json(), (req, res) => {
  const { appointment_id } = req.body || {};
  if (!appointment_id) return res.status(400).json({ error: "appointment_id required" });

  const appt = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(appointment_id);
  if (!appt) return res.status(404).json({ error: "Appointment not found" });

  db.prepare(`UPDATE appointments SET status = 'cancelled' WHERE id = ?`).run(appointment_id);
  res.json({ success: true });
});

// --- Simple HTML page ---
adminRouter.get("/", (req, res) => {
  res.type("html").send(ADMIN_HTML.replaceAll("__SALON_NAME__", config.name));
});

const ADMIN_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>__SALON_NAME__ — Agent Admin</title>
  <style>
    body { font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 800px; margin: 20px auto; padding: 0 16px; color: #222; }
    h1 { font-size: 20px; }
    h2 { font-size: 16px; margin-top: 32px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; }
    .badge.paused { background: #fde2e2; color: #a33; }
    .badge.active { background: #e2f5e2; color: #2a7; }
    button { font-size: 13px; padding: 4px 10px; cursor: pointer; }
    .conv { margin-top: 8px; }
    .messages { max-height: 300px; overflow-y: auto; border: 1px solid #eee; padding: 8px; font-size: 13px; background: #fafafa; margin: 8px 0; }
    .msg { margin: 4px 0; }
    .msg.customer { color: #222; }
    .msg.agent { color: #06c; }
    .msg.owner { color: #a60; }
    textarea { width: 100%; box-sizing: border-box; font-size: 14px; padding: 6px; }
    .row { display: flex; gap: 8px; align-items: center; }
  </style>
</head>
<body>
  <h1>__SALON_NAME__ — Agent Admin</h1>

  <h2>Upcoming appointments</h2>
  <table id="appointments"><thead>
    <tr><th>When</th><th>Service</th><th>Customer</th><th>Phone</th><th></th></tr>
  </thead><tbody></tbody></table>

  <h2>Conversations</h2>
  <div id="conversations"></div>

<script>
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function fmt(iso) {
  return new Date(iso).toLocaleString();
}

async function loadAppointments() {
  const rows = await api('/admin/api/appointments');
  const tbody = document.querySelector('#appointments tbody');
  tbody.innerHTML = '';
  for (const a of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = \`<td>\${fmt(a.start_time)}</td><td>\${a.service_name}</td>
      <td>\${a.customer_name || ''}</td><td>\${a.customer_phone}</td>
      <td><button data-id="\${a.id}" class="cancel">Cancel</button></td>\`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('.cancel').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('Cancel this appointment?')) return;
      await api('/admin/api/cancel', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ appointment_id: btn.dataset.id }) });
      loadAppointments();
    };
  });
}

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

loadAppointments();
loadConversations();
setInterval(() => { loadAppointments(); loadConversations(); }, 15000);
</script>
</body>
</html>`;
