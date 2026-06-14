import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_PHONE_NUMBER;

let client = null;
if (accountSid && authToken) {
  client = twilio(accountSid, authToken);
}

/**
 * Send an SMS via Twilio. If Twilio isn't configured (no credentials in .env),
 * logs to console instead so local dev/testing still works.
 */
export async function sendSms(to, body) {
  if (!client || !fromNumber) {
    console.log(`[SMS would send] to=${to} from=${fromNumber || "(unset)"}: ${body}`);
    return { simulated: true };
  }

  try {
    const msg = await client.messages.create({ to, from: fromNumber, body });
    return { sid: msg.sid };
  } catch (err) {
    console.error(`[SMS send failed] to=${to}:`, err.message);
    throw err;
  }
}
