// Local smoke test — simulates a customer texting the agent, without Twilio.
// Usage: ANTHROPIC_API_KEY=sk-... node src/test_conversation.js
import "dotenv/config";
import { handleInboundMessage } from "./agent.js";

const CUSTOMER = "+15555550123";

const script = [
  "hi, are you open today?",
  "do you have anything for a 60 min deep tissue tomorrow afternoon?",
  "the 3pm one sounds good, can you book that for John?",
];

for (const msg of script) {
  console.log(`\nCustomer: ${msg}`);
  const reply = await handleInboundMessage(CUSTOMER, msg);
  console.log(`Agent: ${reply ?? "(agent paused — human handoff)"}`);
}
