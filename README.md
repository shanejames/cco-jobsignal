# CCO JobSignal

A tiny single service that watches for fractional and interim Customer Success leadership roles,
scores each one against your profile with Groq, dedupes, and pings you on the strong ones.
It creates its own database tables on first boot, so there is nothing to run by hand.

## What it does

1. Pulls roles from public feeds (Remotive, RemoteOK, We Work Remotely) every 20 minutes.
2. Lets you paste alert emails from the fractional boards that do not offer a feed.
3. Scores every posting 1 to 10 against your background, stage, and location preferences.
4. Writes an intro note in your voice for any role that scores 8 or higher, ready to copy and send.
5. Texts you the strong matches and keeps everything in a simple dashboard.

## Cost

Effectively zero. Free Render web service, a free Neon Postgres, Groq free tier. Alerts go by SMS
through your existing Twilio account, which is a fraction of a cent per text at this volume.

## The database

Use a brand new, separate Postgres for this. Do not point it at the Avolv database. Your job hunt
should stay completely walled off from production.

Render's own free Postgres is the wrong choice here because Render deletes free databases 30 days
after creation. Instead, create a free Postgres on Neon (neon.tech), which keeps free instances
running indefinitely. All the app needs is the connection string.

1. Sign up at neon.tech, create a project named cco-jobsignal.
2. Copy the connection string it gives you (it starts with postgresql://).
3. Paste that as DATABASE_URL in Render (next section).

The app creates all of its own tables on first boot, so there is nothing to run by hand.

## Setup on Render (no terminal needed)

1. Put these four files in a new GitHub repo: package.json, server.js, render.yaml, README.md.
2. In Render, create a new Web Service from that repo. Pick the free plan. Build command is
   `npm install` and start command is `node server.js` (the render.yaml sets these for you).
3. Add the environment variables below.
4. Deploy. On first boot it creates its tables automatically. Visit the service URL to see the dashboard.

## Environment variables

Required:
- DATABASE_URL: your Neon connection string (see the database section above).
- GROQ_API_KEY: from console.groq.com. Without it the app still runs on a simple keyword score.
- DASHBOARD_PASSWORD: any password you choose. The dashboard asks for it (username can be anything).
- CRON_SECRET: any random string. Protects the poll and digest endpoints.

For instant alerts by text (uses your existing Twilio account):
- TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN: from your Twilio console.
- ALERT_SMS_FROM: one of your Twilio numbers, in the form +1XXXXXXXXXX.
- ALERT_SMS_TO: your cell number, in the form +1XXXXXXXXXX.

Optional tuning:
- ALERT_THRESHOLD: score that triggers a text. Default 8.
- GROQ_MODEL: defaults to openai/gpt-oss-120b. Override here if you want a different Groq model.

## Your resume, emails, and tailoring

Open "My resume" from the dashboard header and paste your master resume once. It is the single
source of truth. Two features use it:

- Application emails (on any role's detail page) are written in a warm, humble voice and may only
  use facts and numbers that appear in your resume. Nothing gets invented. The email closes with
  "Thank you" and your name. Paste the full posting into the box first so the email speaks to it.
- The tailoring kit (also on the detail page) reads your resume against the posting and tells you
  which existing bullets to lead with, which keywords to include, and a tailored summary. It never
  rewrites or invents, it only reorders and surfaces what you already wrote.

Optional env var:
- USER_NAME: the name the emails sign off with. Defaults to Shane James.

## The forwarding inbox (hands-off ingestion)

Instead of pasting emails by hand, set up a dedicated mailbox that the app reads on every cycle.
Forward (or auto-forward) job alert emails to it and they flow in on their own.

1. Create a new free Gmail just for this, for example ccojobsignal@gmail.com.
2. Turn on 2 Step Verification on that account, then create an App Password
   (Google Account, Security, App passwords). It gives you a 16 character password.
3. In Render add:
   - IMAP_USER: the full address (ccojobsignal@gmail.com)
   - IMAP_PASS: the 16 character App Password (not your normal password)
4. In your main Gmail, set up a filter that auto-forwards LinkedIn, Indeed, Go Fractional, and
   newsletter alerts to the new address. Gmail to Gmail forwarding only needs one confirmation click.

On each cycle the app reads unread messages in that inbox, pulls out the postings, scores them,
texts you the strong ones, and marks the email read. It tags the source from the sender automatically.

Optional email digest (uses Resend, which you already use for Arinton):
- RESEND_API_KEY, ALERT_EMAIL_FROM, ALERT_EMAIL_TO.

## Keep it polling on the free plan

Render free web services sleep when idle, which would pause the internal scheduler. The fix is to
have something ping the poll endpoint on a schedule. That ping both wakes the service and runs the poll.

1. Go to cron-job.org (free) and create a cronjob.
2. URL: https://your-service.onrender.com/cron/poll?key=YOUR_CRON_SECRET
3. Schedule: every 20 or 30 minutes.

Optional second job for a daily email digest:
- URL: https://your-service.onrender.com/cron/digest?key=YOUR_CRON_SECRET, once a day.

## Turn on the firehose (the part that ends the daily site-checking)

The fractional specific boards do not all publish feeds, so route their alerts to your inbox and
paste them in. Do this once:

1. Set up saved-search email alerts on LinkedIn and Indeed for phrases like
   fractional customer success, fractional CCO, interim VP customer success, head of CS contract.
2. Create a Go Fractional profile at app.gofractional.com so it emails you matches. It sits behind a
   login and bot detection, so the email route is how its roles get in.
3. Subscribe to the Fractional Pulse and Fractional Jobs newsletters.
4. When one lands, copy the email body, open the dashboard, and paste it in.

To paste an email: open the dashboard, tap "Paste an alert email" in the header (or go to /paste),
pick the source (Go Fractional, LinkedIn, Indeed, Fractional Pulse, Fractional Jobs, Bolster, Other),
paste the email body, and tap Scan and score. Groq pulls out each posting, scores it, and pings you
on anything strong. Works fine from your phone.

## Dashboard

- Visit the service URL, enter your DASHBOARD_PASSWORD.
- Roles are sorted by fit score. Tabs filter by active, applied, passed, or all.
- Each strong role shows the intro note under a toggle. Mark roles applied or passed as you work.

## Adding more sources

Open server.js, find the SOURCES array, and add an entry with a fetch function that returns roles in
the same shape as the others. Anything that returns JSON or RSS is easy to wire in.
