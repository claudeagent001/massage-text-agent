import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, "..", "data.sqlite"));

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS appointments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_phone TEXT NOT NULL,
  customer_name  TEXT,
  service_id     TEXT NOT NULL,
  service_name   TEXT NOT NULL,
  start_time     TEXT NOT NULL,  -- ISO 8601, local salon time
  end_time       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | cancelled
  reminder_sent  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_phone TEXT NOT NULL,
  direction      TEXT NOT NULL,  -- inbound | outbound
  sent_by        TEXT NOT NULL DEFAULT 'agent', -- agent | owner | customer
  body           TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversation_state (
  customer_phone TEXT PRIMARY KEY,
  agent_paused   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_appt_time ON appointments (start_time);
`);

export default db;
