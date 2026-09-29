import "dotenv/config";
import nodemailer from "nodemailer";

export type Mail = { to: string; subject: string; text: string };

type Transport = { send(mail: Mail): Promise<void>; verify(): Promise<void> };

// Brevo's HTTPS API, for hosts that block outbound SMTP (Render's free tier does). BREVO_API_KEY
// is an API key from Brevo's SMTP & API settings; MAIL_FROM is a sender address verified in Brevo.
function brevo(apiKey: string, from: string): Transport {
  async function call(path: string, init: RequestInit = {}): Promise<void> {
    const response = await fetch(`https://api.brevo.com/v3/${path}`, {
      ...init,
      headers: { "api-key": apiKey, accept: "application/json", "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Brevo ${path} failed with ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return {
    send: (mail) => call("smtp/email", {
      method: "POST",
      body: JSON.stringify({ sender: { name: "HomeHub", email: from }, to: [{ email: mail.to }], subject: mail.subject, textContent: mail.text }),
    }),
    // Reads the account, which fails on a wrong key without sending anything.
    verify: () => call("account"),
  };
}

// Gmail with an App Password: EMAIL_USER is the Gmail address, EMAIL_PASS the 16-character key
// Google issues under 2-Step Verification. Needs outbound SMTP, so it suits local runs.
function gmail(user: string, pass: string): Transport {
  const transport = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  return {
    send: async (mail) => { await transport.sendMail({ from: `HomeHub <${user}>`, ...mail }); },
    verify: async () => { await transport.verify(); },
  };
}

// Brevo wins when both are set. With neither, mail is printed to the console so the reset flow
// can be exercised locally with no account at all.
const brevoKey = process.env["BREVO_API_KEY"];
const mailFrom = process.env["MAIL_FROM"];
const user = process.env["EMAIL_USER"];
const pass = process.env["EMAIL_PASS"];
const transport = brevoKey && mailFrom ? brevo(brevoKey, mailFrom) : user && pass ? gmail(user, pass) : null;

// An object rather than bare functions so tests can replace `send`.
export const mailer = {
  configured: transport !== null,

  async send(mail: Mail): Promise<void> {
    if (!transport) {
      console.log(`[mail not configured] To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}`);
      return;
    }
    await transport.send(mail);
  },

  // Checks the credentials without sending anything.
  async verify(): Promise<boolean> {
    if (!transport) return false;
    await transport.verify();
    return true;
  },
};
