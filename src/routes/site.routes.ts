import "dotenv/config";
import { Router } from "express";

// Public pages outside /api. Google's OAuth consent screen links to the homepage and privacy
// policy, and the host pings /health to see that the server is up.
const router = Router();

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const contact = process.env["CONTACT_EMAIL"];
const contactLine = contact
  ? `<a href="mailto:${escape(contact)}">${escape(contact)}</a>`
  : "the person who invited you to HomeHub";

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;color:#222}h1{font-size:1.6rem}h2{font-size:1.15rem;margin-top:1.8rem}</style>
</head><body>${body}</body></html>`;

const home = page("HomeHub", `
<h1>HomeHub</h1>
<p>HomeHub is a small Android app for running a shared home. Household members keep tasks and
expenses together, chat, and share posts and photos with each other.</p>
<p>The app is shared privately with friends and family and is not listed on any app store.</p>
<p><a href="/privacy">Privacy policy</a></p>`);

const privacy = page("HomeHub privacy policy", `
<h1>HomeHub privacy policy</h1>
<p>Last updated: 29 September 2026</p>

<h2>What HomeHub stores</h2>
<ul>
<li>Your account: name, email address, and a hashed password. If you sign in with Google, your
Google account ID, name and email address instead of a password.</li>
<li>What you add to a household: tasks, expenses, chat messages, posts, comments, likes and photos.</li>
<li>Your phone's push notification token, so the app can send you notifications.</li>
</ul>

<h2>Google user data</h2>
<p>Google sign-in is used only to confirm who you are. HomeHub reads your Google account ID, name
and email address, and nothing else from your Google account. This data is not shared with anyone
or used for advertising.</p>

<h2>Who can see your data</h2>
<p>Only members of the households you belong to see what you add to them. HomeHub has no ads and
no analytics, and does not sell or share personal data.</p>

<h2>Services that process data for HomeHub</h2>
<ul>
<li>Render hosts the server, and Supabase hosts the database.</li>
<li>Cloudinary stores photos.</li>
<li>Expo and Google Firebase deliver push notifications.</li>
<li>Brevo sends password reset emails.</li>
</ul>

<h2>Deleting your data</h2>
<p>To delete your account and everything it holds, contact ${contactLine}.</p>`);

router.get("/", (_req, res) => { res.type("html").send(home); });
router.get("/privacy", (_req, res) => { res.type("html").send(privacy); });
router.get("/health", (_req, res) => { res.json({ status: "ok" }); });

export default router;
