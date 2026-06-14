import Anthropic from "@anthropic-ai/sdk";
import db from "./db.js";
import { buildSystemPrompt } from "./prompt.js";
import { toolDefinitions, runTool } from "./tools/index.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-4-6";
const HISTORY_LIMIT = 20; // recent messages to include for context

function getConversationState(phone) {
  const row = db.prepare(`SELECT agent_paused FROM conversation_state WHERE customer_phone = ?`).get(phone);
  return row || { agent_paused: 0 };
}

function getRecentMessages(phone) {
  const rows = db
    .prepare(
      `SELECT direction, sent_by, body FROM messages
       WHERE customer_phone = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(phone, HISTORY_LIMIT);
  return rows.reverse();
}

function saveMessage(phone, direction, sentBy, body) {
  db.prepare(
    `INSERT INTO messages (customer_phone, direction, sent_by, body) VALUES (?, ?, ?, ?)`
  ).run(phone, direction, sentBy, body);
}

/**
 * Handle an inbound SMS from a customer. Returns the text reply to send back,
 * or null if the agent should stay silent (e.g. conversation paused for human handoff).
 */
export async function handleInboundMessage(customerPhone, messageBody) {
  saveMessage(customerPhone, "inbound", "customer", messageBody);

  const state = getConversationState(customerPhone);
  if (state.agent_paused) {
    // A human has taken over this conversation; agent stays quiet.
    return null;
  }

  const history = getRecentMessages(customerPhone);
  const messages = history.map((m) => ({
    role: m.direction === "inbound" ? "user" : "assistant",
    content: m.body,
  }));

  const ctx = { customerPhone };
  const systemPrompt = buildSystemPrompt();

  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    tools: toolDefinitions,
    messages,
  });

  // Tool-use loop
  while (response.stop_reason === "tool_use") {
    const toolResults = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const result = await runTool(block.name, block.input, ctx);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
    }

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });

    // If notify_owner was called, re-check pause state — if paused, stop after this turn.
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      tools: toolDefinitions,
      messages,
    });
  }

  const textBlock = response.content.find((b) => b.type === "text");
  const replyText = textBlock ? textBlock.text : "Sorry, I didn't catch that — could you try again?";

  saveMessage(customerPhone, "outbound", "agent", replyText);
  return replyText;
}
