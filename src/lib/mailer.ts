import "dotenv/config";
import nodemailer from "nodemailer";

export type Mail = { to: string; subject: string; text: string };

// Gmail with an App Password: EMAIL_USER is the Gmail address, EMAIL_PASS the 16-character key
// Google issues under 2-Step Verification. Without them, mail is printed to the console so the
// reset flow can be exercised locally with no account at all.
const user = process.env["EMAIL_USER"];
const pass = process.env["EMAIL_PASS"];
const transport = user && pass ? nodemailer.createTransport({ service: "gmail", auth: { user, pass } }) : null;

// An object rather than bare functions so tests can replace `send`.
export const mailer = {
  configured: transport !== null,

  async send(mail: Mail): Promise<void> {
    if (!transport) {
      console.log(`[mail not configured] To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}`);
      return;
    }
    await transport.sendMail({ from: `HomeHub <${user}>`, ...mail });
  },

  // Logs in to the mail server without sending anything, to check the credentials.
  async verify(): Promise<boolean> {
    if (!transport) return false;
    await transport.verify();
    return true;
  },
};
