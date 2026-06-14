import "dotenv/config";
import express from "express";
import twilio from "twilio";
import { handleInboundMessage } from "./agent.js";
import { adminRouter } from "./admin.js";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use("/admin", adminRouter);

const { MessagingResponse } = twilio.twiml;

// Twilio webhook: configure this URL as the "A message comes in" webhook
// for your Twilio phone number (Messaging -> A message comes in -> Webhook, POST).
app.post("/sms", async (req, res) => {
  const from = req.body.From; // customer's phone number, e.g. +15551234567
  const body = req.body.Body || "";

  console.log(`[SMS in] ${from}: ${body}`);

  let reply;
  try {
    reply = await handleInboundMessage(from, body);
  } catch (err) {
    console.error("Agent error:", err);
    reply = "Sorry, something went wrong on our end. We'll text you back shortly.";
  }

  const twiml = new MessagingResponse();
  if (reply) {
    twiml.message(reply);
    console.log(`[SMS out] ${from}: ${reply}`);
  } else {
    console.log(`[SMS out] (agent paused, no reply sent)`);
  }

  res.type("text/xml").send(twiml.toString());
});

app.get("/health", (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Massage text agent listening on port ${port}`));
