# HomeHub deployment guide

How HomeHub runs in production, how it was set up on 29–30 September 2026, and how to change, fix or roll it back. This file holds no passwords or keys; section 4 says where each one lives.

## 1. What runs where

| Part | Service | Plan | Location |
|---|---|---|---|
| Android app | APK built by EAS Build, installed directly (not on the Play Store) | Free | Friends' phones |
| API server (this repo) | Render web service `homehub` | Free | Singapore |
| Database | Supabase project `homehub`, PostgreSQL 17 | Free | Singapore (`ap-southeast-1`) |
| Photos | Cloudinary. The app uploads straight to it with a ticket the server signs | Free | Cloud |
| Password reset email | Brevo, through its HTTPS API | Free | Cloud |
| Push notifications | Expo push service, then Firebase Cloud Messaging | Free | Cloud |
| Google sign-in | Google Cloud project `homehub-509117` | Free | Cloud |
| Keep-awake ping | UptimeRobot, calls `/health` every 5 minutes | Free | Cloud |

Addresses:

- API: https://homehub-5w7p.onrender.com/api
- Health check: https://homehub-5w7p.onrender.com/health answers `{"status":"ok"}`
- Homepage and privacy policy, which Google's consent screen links to: https://homehub-5w7p.onrender.com/ and https://homehub-5w7p.onrender.com/privacy

A request travels from the phone to Render over HTTPS, and from Render to Supabase over an encrypted, certificate-checked connection. The server and the database are both in Singapore, so a database query takes 1–2 ms. The trip from a phone in India to the server takes about 60 ms.

Everything runs on free plans, so the monthly cost is $0. Section 6 lists the limits that come with that.

## 2. How it was set up

### Step 1: backend changes for hosting

Commit `380d76d` prepared the code:

- `src/routes/site.routes.ts` serves three public pages: `/` (homepage), `/privacy` (privacy policy) and `/health`. Google requires a homepage and a privacy policy before the sign-in consent screen can be published. Render and UptimeRobot call `/health` to check that the server is up.
- `src/lib/mailer.ts` sends email through Brevo's HTTPS API when `BREVO_API_KEY` and `MAIL_FROM` are set. Render's free plan blocks outgoing SMTP, so Gmail can't send from there. Gmail (`EMAIL_USER` and `EMAIL_PASS`) still works for local runs.
- `package.json`:
  - `tsx` moved from `devDependencies` to `dependencies`, because the server runs TypeScript directly through `tsx`, so the host needs it installed.
  - New script `build` runs `prisma generate`. The generated Prisma client is not in git, so the host has to create it.
  - New script `migrate:deploy` runs `prisma migrate deploy`, which applies new database migrations.
  - `engines.node` is `22.x`, so Render uses Node 22.
- `certs/supabase-root-2021-ca.crt` is Supabase's public root certificate (see step 2).
- `.env.example` lists every environment variable with an explanation.

### Step 2: database on Supabase

1. **Created the project** `homehub` on the Free plan (Nano compute) in **Southeast Asia (Singapore)**. Singapore rather than Mumbai, because Render has no Mumbai region, and keeping the server next to the database avoids about 60 ms on every query.
2. **Turned off the Data API** when creating the project ("Enable Data API" unticked). Supabase can publish tables as a web API that anyone with the project's public key can call. Our tables have no Supabase access rules (the server does its own checks), so leaving it on would have exposed them. The dashboard shows PostgREST as "Disabled"; that is expected.
3. **Took the connection string** from Connect, then Direct, then Method **Session pooler**. It has this form:
   `postgresql://postgres.<project-ref>:<password>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`
   - The direct connection host only works over IPv6, which Render can't reach.
   - The transaction pooler (port 6543) doesn't support everything Prisma and the server rely on.
4. **Made the connection encrypted and verified** by adding `?sslmode=verify-full&sslrootcert=certs/supabase-root-2021-ca.crt` to the end of the string.
   - Without it, Supabase also accepts unencrypted connections, so the password and data would travel in plain text.
   - Supabase signs its certificates with its own authority, "Supabase Root 2021 CA", which isn't in the list computers trust by default. That is why the certificate file is in the repo. It was downloaded from Supabase and checked against the certificate the pooler actually presents. It is public, not a secret, and it expires in **April 2031**.
   - Both the app's database driver and the Prisma migration tool accept this string.
5. **Created the tables** by running all 19 migrations from the PC with `npm run migrate:deploy`. Since then, every Render build applies new migrations by itself.

### Step 3: email with Brevo

1. Created a free Brevo account, with "HomeHub" as the organisation name.
2. Added the sender "HomeHub" with your Gmail address, and verified it with the code Brevo emailed.
3. Created an API key named `homehub` under SMTP & API, then **API keys**. An API key starts with `xkeysib-`. The SMTP tab creates `xsmtpsib-` keys, which don't work with the API.
4. Tested it: the key check passed, and a test reset email arrived.

Brevo shows the warning "Freemail domain is not recommended". Brevo sends as your `@gmail.com` address from its own servers and can't sign mail on Gmail's behalf. Gmail's policy for this (DMARC) is currently `p=none`, so the mail is delivered, but it may land in spam. If that becomes a problem, buy a domain and connect it in Brevo under Senders, Domains & Dedicated IPs, then Domains.

### Step 4: commit and push

Commit `380d76d` was pushed to `main`.

Both GitHub repos are **public**. Before pushing, the full history of both was scanned for passwords, keys and tokens, and none were found. The frontend's `google-services.json` is committed on purpose; the Firebase key in it ships inside every APK anyway. `.env` and `.env.production` are ignored by git.

### Step 5: API server on Render

Signed up with GitHub and gave Render access to the `home-management` repo only. Then New, Web Service, on the **Git Provider** tab. The "Public Git Repository" tab would also work, but it can't deploy automatically on push.

| Setting | Value |
|---|---|
| Name | `homehub`. Render added `-5w7p` to the address because `homehub` was taken |
| Project | None |
| Language | Node |
| Branch | `main` |
| Region | Singapore |
| Root Directory | Empty |
| Build Command | `npm ci && npm run build && npm run migrate:deploy` |
| Start Command | `npm start` |
| Instance Type | Free ($0). The page pre-selects the paid Starter ($7) plan |
| Environment Variables | The 8 in section 4, pasted with "Add from .env" |
| Health Check Path | `/health` |
| Pre-Deploy Command | Empty. It is a paid feature, and the build command runs migrations instead |
| Auto-Deploy | On Commit |

What the build command does, in order:

1. `npm ci` installs the exact package versions from `package-lock.json`.
2. `npm run build` generates the Prisma client.
3. `npm run migrate:deploy` applies any new migrations to Supabase.

`npm start` then runs `tsx src/server.ts`. Render tells the server to listen on port 10000.

Before creating the service, the server was started on the PC with exactly the production settings, to catch problems early. The first deploy took 1 minute 15 seconds. These checks passed afterwards: `/health`, `/`, `/privacy`, a login with a wrong password (which reaches the database and answers in 0.25 s), and the chat connection (socket.io).

### Step 6: Google sign-in consent screen

This is done in the Google Cloud project **HomeHub** (ID `homehub-509117`, number `16019890062`), which holds the sign-in OAuth clients. It is **not** the Firebase project `homehub-16c85`, which is used for push notifications.

Under Google Auth Platform, then **Branding**:

| Field | Value |
|---|---|
| App name | HomeHub |
| User support email | Your Gmail |
| App logo | Empty. A logo would trigger Google's review |
| Application home page | https://homehub-5w7p.onrender.com/ |
| Privacy policy link | https://homehub-5w7p.onrender.com/privacy |
| Authorized domain | `homehub-5w7p.onrender.com`. The full name is needed because Google treats every `onrender.com` subdomain as a separate domain |
| Developer contact | Your Gmail |

Then **Audience**, **Publish app**, **Confirm**. The status is now **In production**. Before this, only listed test users could sign in with Google. No review was needed, because the app asks Google only for name, email and profile, has no logo, and uses one domain.

### Step 7: the Android app

1. **Over-the-air update settings** (commit `bfc155a` on the frontend's `master`). `eas update:configure` added the update URL and `runtimeVersion` (policy `appVersion`) to `app.json`, and a release channel per build profile to `eas.json`. The `preview` profile also has `environment: preview` and `autoIncrement`.
2. **Build settings on EAS**, in the `preview` environment:
   - `EXPO_PUBLIC_API_URL` = `https://homehub-5w7p.onrender.com/api`, set with `eas env:set preview --name EXPO_PUBLIC_API_URL --value https://homehub-5w7p.onrender.com/api --visibility plaintext`
   - `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, the Google web client ID

   `EXPO_PUBLIC_` values are built into the app. Without the API address, the app falls back to `http://10.0.2.2:3000/api`, the emulator's address for your PC, which a real phone can't reach.
3. **Signing.** EAS keeps the app's signing key (created 27 September). Its SHA-1 fingerprint, `2C:FC:62:F9:37:F8:2B:01:F2:74:78:B1:71:DF:31:C2:4C:C0:1E:0C`, is registered on the Android OAuth client in `homehub-509117`. Google sign-in only works in builds signed with this key. The Firebase Cloud Messaging key for push notifications is also stored on EAS.
4. **The build:** `eas build --platform android --profile preview` produces an APK (version 1.0.0, build number 2) from commit `bfc155a`. The local `android` folder is ignored by git and never uploaded. EAS generates the native project from `app.json` itself.
5. **Installing:** open the build page on the phone, tap Install, and allow "Install unknown apps" for the browser. Uninstall any old debug build first, because it was signed with a different key.

### Step 8: keeping the server awake

Render's free services go to sleep after 15 minutes without requests, and take about a minute to wake up. The app gives up on a request after 15 seconds, so the first tap after a quiet spell would fail.

The UptimeRobot monitor `homehub` calls https://homehub-5w7p.onrender.com/health every 5 minutes, so the server never sleeps. It also emails you if the server goes down.

Render gives each workspace 750 free hours a month, and one service running all month uses up to 744 (31 days × 24 hours). The older practice service, in the Render project "My project", was suspended so that the two together stay within the limit.

Because the server's chat worker queries the database every second, Supabase also never reaches its 7-day inactivity pause.

## 3. Everyday tasks

### Work locally

Local development works as before. Nothing reads `.env.production` unless you pass it on purpose.

Backend:

1. Start your local PostgreSQL (`localhost:5432`, database `homehub`).
2. Run `npm run dev`. It reads `.env`, which points at the local database and uses Gmail for email.
3. For schema changes, `npx prisma migrate dev --name <what-changed>` only touches the local database.

App:

- `EXPO_PUBLIC_API_URL` in the frontend's `.env` decides which server the app talks to:
  - Set to `https://homehub-5w7p.onrender.com/api`: the live server, with real data.
  - Removed or commented out: the backend on your PC, which the app finds by itself through the Expo dev server's address.
- After changing it, restart with `npx expo start -c`. The `-c` clears the cache so the new value is used.
- A local build (`npm run android`) and the preview APK have the same package name but different signing keys, so Android can't install one over the other. Use the emulator for local builds, or uninstall the APK first, which signs you out of it.

Git:

- Every push to the backend's `main` deploys to production. Keep unfinished work on a branch (`git switch -c <name>`) and merge it into `main` when it's ready.
- Pushing the frontend deploys nothing. The installed app only changes when you run `eas update` or `eas build`.

### Deploy a backend change

1. Run `npm run typecheck` and `npm test`.
2. Push to `main`. Render builds and deploys by itself; follow it under Render, homehub, Events or Logs.

If the build fails, the running version isn't touched. On the free plan, a successful deploy causes a short outage (under a minute) while the old server stops and the new one starts. Zero-downtime deploys are a paid feature.

### Change the database schema

1. Edit `prisma/schema.prisma` and run `npx prisma migrate dev --name <what-changed>` against your local database.
2. Commit the new folder in `prisma/migrations` together with the code, and push.
3. The Render build applies the migration before the new server starts.

The migration runs while the old server is still answering requests, and rolling back the code does not undo it. So keep each migration compatible with the code that is already running: add new tables and optional columns, and remove or rename things only in a later release, once no code uses them.

To see which migrations the production database has, run this from the backend folder:

```
node --env-file=.env.production node_modules/prisma/build/index.js migrate status
```

### Change an environment variable

In Render, open homehub, then Environment. Edit the value, then save and choose to deploy. Change it in `.env.production` too, so your local copy stays accurate.

### Ship an app update without a new APK

For changes to JavaScript and TypeScript only (screens, logic, styles, text), from the frontend folder:

```
eas update --channel preview --environment preview --message "what changed"
```

Installed apps download the update the next time they start, and use it the time after that.

**Always include `--environment preview`.** Without it, the update is built from your local `.env` instead. If that points at your PC, as it does during local development, every installed app would lose the server.

To undo an update, run `eas update:rollback`. It republishes the previous update, or returns to the version inside the APK.

### Build a new APK

A new APK is needed when something native changes: a new library with native code, a permission or plugin in `app.json`, an Expo SDK upgrade, or the icon, splash screen or app name.

1. Raise `version` in `app.json`, for example from 1.0.0 to 1.1.0. The runtime version follows the app version, so updates made for the new APK are never sent to old APKs that lack its native code, where they would crash.
2. Run `eas build --platform android --profile preview`.
3. Everyone installs the new APK over the old one. It uses the same signing key, so their data stays.

The build number goes up automatically.

### Roll back

| What | How |
|---|---|
| Backend code | Render, homehub, Events: pick an earlier successful deploy and choose Rollback. Afterwards, check under Settings that Auto-Deploy is still on, then fix the problem on `main`. This does not undo database migrations |
| App update | `eas update:rollback` |
| APK | Install the earlier build from expo.dev, Builds |
| Database | See "Backups" in section 8 |

### Replace a secret

| Secret | Where to create a new one | Then |
|---|---|---|
| Database password | Supabase, Project Settings, Database: reset the database password | Update `DATABASE_URL` in Render and in `.env.production` |
| `JWT_SECRET` | Any long random string, for example from `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` | Update it in Render. Everyone is signed out |
| Brevo API key | Brevo, SMTP & API, API keys: create a new key, then delete the old one | Update it in Render |
| Cloudinary | Cloudinary Console, Settings, API Keys | Update `CLOUDINARY_URL` in Render and in your local `.env` |
| Expo access token | expo.dev, Account settings, Access tokens | Update `EXPO_ACCESS_TOKEN` in Render |

### Run the server locally with production settings

`.env.production` (ignored by git) holds the same values as Render. For a short check:

```
node --env-file=.env.production --import tsx src/server.ts
```

This talks to the real database, and sends real email and push notifications. It also runs a second copy of the chat delivery worker next to Render's, and the server is meant to run as a single copy, so stop it when you're done.

## 4. Settings reference

### Backend: Render, homehub, Environment

| Name | What it is | Where the value comes from |
|---|---|---|
| `DATABASE_URL` | Supabase session pooler address, ending in `?sslmode=verify-full&sslrootcert=certs/supabase-root-2021-ca.crt` | Supabase, Connect, Direct, Session pooler. The password is in your password manager |
| `JWT_SECRET` | Signs login tokens. Production has its own, different from local | Generated randomly on 29 September |
| `GOOGLE_CLIENT_IDS` | Web client ID whose Google sign-in tokens the server accepts | Google Cloud `homehub-509117`, Clients. Same as local |
| `CLOUDINARY_URL` | `cloudinary://key:secret@cloud` | Cloudinary Console. Same account as local |
| `BREVO_API_KEY` | Brevo API key, starting with `xkeysib-` | Brevo, SMTP & API, API keys |
| `MAIL_FROM` | Sender address. It must be verified in Brevo | Your Gmail |
| `EXPO_ACCESS_TOKEN` | Lets the server send push notifications through Expo | expo.dev, Access tokens. Same as local |
| `EXPO_PUSH_ENABLED` | `true` sends chat messages as push notifications | Set to `true` |

Optional and not set:

- `CONTACT_EMAIL` is shown on `/privacy` for account deletion requests. Without it, the page says to contact the person who invited you.
- `WEB_ORIGINS` is only needed for the Expo web preview.

Local copies: `.env` has the development values, and `.env.production` has the same values as Render. Both are ignored by git.

### App: EAS, environment `preview`

| Name | Value |
|---|---|
| `EXPO_PUBLIC_API_URL` | `https://homehub-5w7p.onrender.com/api` |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | The Google web client ID, the same as `GOOGLE_CLIENT_IDS` |

These are not secret, since they end up inside the app. To list them, run `eas env:list --environment preview`.

## 5. Troubleshooting

| Problem | Likely cause | What to do |
|---|---|---|
| The app says "The request timed out" or "Cannot reach HomeHub" | The server is asleep, suspended or broken | Open `/health` in a browser. If it's slow and then answers, it was asleep, so check that the UptimeRobot monitor is running. If it says "Service Suspended", go to Render, homehub, Settings and choose Resume. Otherwise read Render, Logs |
| A Render deploy failed | A build step failed | Render, Events: open the failed deploy and read its log. The previous version keeps running. "P1000 authentication failed" means the password in `DATABASE_URL` is wrong |
| A password reset email doesn't arrive | Spam folder, or Brevo refused it | Check the spam folder. Look for the email in Brevo, Transactional, Logs. Brevo can block calls from new IP addresses (such as Render's) and emails you when it does; approve the address under Security, Authorised IPs. Render's log shows "Could not send the password reset email" when sending fails |
| Google sign-in fails in the APK, often with DEVELOPER_ERROR | The signing key's SHA-1 isn't registered, or the consent screen isn't published | `eas credentials -p android` shows the SHA-1. It must be on the Android OAuth client for package `com.praveen_dev.homehub` in `homehub-509117`, not in Firebase. The consent screen must say In production |
| No push notifications for chat messages | Push is off, or blocked on the phone | Check that `EXPO_PUSH_ENABLED` is `true` in Render, that notifications are allowed in the phone's settings, and that `eas credentials -p android` shows the FCM key |
| Photos won't upload | Cloudinary isn't configured | The server answers "Image uploads are not configured on this server". Check `CLOUDINARY_URL` in Render |
| Database errors after a quiet week | Supabase paused the project | Supabase dashboard: Restore. This shouldn't happen while the server is running |
| UptimeRobot says Down | A real outage, or the service was suspended | Open `/health` yourself, then check the Render dashboard |

## 6. Free-plan limits

| Service | Limit | What it means for HomeHub |
|---|---|---|
| Render | 750 hours a month per workspace, 512 MB memory, sleeps after 15 idle minutes | Room for one always-on service. Keep other services suspended |
| Supabase | 500 MB database, pauses after 7 days without activity | Plenty for a group of friends. Check usage in the dashboard now and then |
| Brevo | 300 emails a day | Used only for password reset emails |
| UptimeRobot | Checks every 5 minutes, 50 monitors | One monitor is used |
| EAS | A limited number of builds a month, in a slower queue | Use over-the-air updates for JavaScript-only changes |
| Cloudinary | A monthly usage allowance | Check usage in the Cloudinary dashboard |

The Supabase certificate in `certs/` expires in April 2031. Before then, download the new one from Supabase (database settings, SSL configuration) and replace the file.

## 7. Lessons from the first deployment

- When replacing `[YOUR-PASSWORD]` in the Supabase connection string, remove the square brackets too.
- Brevo's SMTP tab gives `xsmtpsib-` keys. The API needs an `xkeysib-` key from the API keys tab.
- `eas env:create` is deprecated. Use `eas env:set`.
- Render pre-selects the paid Starter plan ($7) and guesses the build and start commands. Check that the price says $0 and replace both commands.
- Supabase's region defaults to "Auto". Choose Singapore yourself.
- Check a service's name before suspending it. `homehub` was once suspended by mistake; resuming it brought it back within a minute, with nothing lost.
- The Google sign-in project (`homehub-509117`) and the Firebase project (`homehub-16c85`) are different projects.

## 8. Still to do

- **Test the APK on a phone:**
  - sign up, sign out and sign in
  - Google sign-in
  - create a household and invite someone
  - a task and an expense with a photo
  - chat with a photo
  - a post with a like and a comment
  - push notifications
  - forgot password
- **Backups.** Check what Supabase's free plan offers under Database, Backups. If it offers none you can download, take your own copy now and then with `pg_dump`.
- **Optional:** set `CONTACT_EMAIL` in Render. Buy a domain if reset emails keep landing in spam; it also gives the app a nicer address.
- **Next feature:** typing indicator and online/last seen, planned as an over-the-air update.
