"use strict";

// CCO JobSignal
// A single-service monitor for fractional and interim Customer Success leadership roles.
// It pulls from public job feeds, lets you paste alert emails from the fractional boards,
// scores every posting against your profile with Groq, dedupes, and pings you on the strong ones.
// It auto-creates its own tables on first boot, so there is no SQL to run by hand.

const express = require("express");
const { Pool } = require("pg");
const Parser = require("rss-parser");
const cron = require("node-cron");

let Groq = null;
try {
  Groq = require("groq-sdk");
} catch (err) {
  console.log("groq-sdk not loaded, scoring will use the keyword fallback");
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || "";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const CRON_SECRET = process.env.CRON_SECRET || "";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const ALERT_SMS_FROM = process.env.ALERT_SMS_FROM || "";
const ALERT_SMS_TO = process.env.ALERT_SMS_TO || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const ALERT_EMAIL_FROM = process.env.ALERT_EMAIL_FROM || "";
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || "";
const ALERT_THRESHOLD = parseInt(process.env.ALERT_THRESHOLD || "8", 10);
const RUN_INTERNAL_CRON = (process.env.RUN_INTERNAL_CRON || "true") === "true";

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
});

const groq = GROQ_API_KEY && Groq ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const rss = new Parser({ timeout: 20000 });

// ---------------------------------------------------------------------------
// Your profile, used to score every posting and to write the intro note
// ---------------------------------------------------------------------------

const PROFILE = [
  "Target roles: fractional, interim, or part time Chief Customer Officer, Head of Customer Success,",
  "VP Customer Success, VP Customer Experience, or senior CS or CX leadership.",
  "Background: 25 plus years of C suite Customer Success leadership in B2B SaaS, two Fortune 500 exits,",
  "churn reduced from 22 percent to 7 percent, NRR improved from 85 percent to 115 percent, CISSP, MS Purdue.",
  "Best fit company stage: Series A to C SaaS.",
  "Location: remote preferred, or Tampa Bay, Florida. On site far from Tampa is a negative.",
  "Strongly prefer fractional, interim, or part time. A strong full time CCO or VP CS role at a good SaaS",
  "company still counts but should score a little lower than an equivalent fractional one.",
  "Score low: non CS roles, junior or manager level roles, non SaaS, sales only or marketing only roles,",
  "staffing agency spam, and anything that is clearly not leadership."
].join(" ");

const WRITING_STYLE = [
  "Warm and friendly, never cocky or corporate. Lead with curiosity about the company.",
  "Tuck achievements into context rather than listing them. Use a soft, no pressure ask.",
  "Keep it to four to six sentences. Close with the exact line: Talk soon.",
  "Never use em dashes. Use commas, periods, parentheses, semicolons, or colons instead."
].join(" ");

// Cheap pre filter so we only spend Groq calls on plausible roles.
const KEYWORDS = [
  "customer success", "customer experience", "head of cs", "head of customer",
  "vp customer", "vice president customer", "chief customer", "cco",
  "fractional", "interim", "customer retention", "churn", "customer outcomes",
  "client success", "post sales", "customer onboarding lead"
];

// ---------------------------------------------------------------------------
// Sources with real public feeds. The fractional specific boards mostly do not
// expose clean feeds, so those come in through the paste an email route below.
// ---------------------------------------------------------------------------

const SOURCES = [
  {
    name: "Remotive (customer success)",
    type: "api",
    fetch: async () => {
      const res = await fetch("https://remotive.com/api/remote-jobs?search=customer%20success&limit=50");
      if (!res.ok) throw new Error("Remotive status " + res.status);
      const data = await res.json();
      return (data.jobs || []).map((j) => ({
        url: j.url,
        title: j.title,
        company: j.company_name,
        location: j.candidate_required_location || "Remote",
        remote_flag: true,
        comp_text: j.salary || "",
        posted_at: j.publication_date ? new Date(j.publication_date) : null,
        description: stripHtml(j.description || "").slice(0, 4000)
      }));
    }
  },
  {
    name: "RemoteOK",
    type: "api",
    fetch: async () => {
      const res = await fetch("https://remoteok.com/api", {
        headers: { "User-Agent": "cco-jobsignal" }
      });
      if (!res.ok) throw new Error("RemoteOK status " + res.status);
      const data = await res.json();
      return (Array.isArray(data) ? data : [])
        .filter((j) => j && j.position)
        .map((j) => ({
          url: j.url,
          title: j.position,
          company: j.company,
          location: j.location || "Remote",
          remote_flag: true,
          comp_text: j.salary || "",
          posted_at: j.date ? new Date(j.date) : null,
          description: stripHtml(j.description || "").slice(0, 4000)
        }));
    }
  },
  {
    name: "We Work Remotely (all)",
    type: "rss",
    fetch: async () => {
      const feed = await rss.parseURL("https://weworkremotely.com/remote-jobs.rss");
      return (feed.items || []).map((it) => ({
        url: it.link,
        title: it.title,
        company: (it.title && it.title.includes(":")) ? it.title.split(":")[0].trim() : "",
        location: "Remote",
        remote_flag: true,
        comp_text: "",
        posted_at: it.isoDate ? new Date(it.isoDate) : null,
        description: stripHtml(it.contentSnippet || it.content || "").slice(0, 4000)
      }));
    }
  }
];

// Marketplaces and boards that do not publish a clean public feed. These send you
// match emails instead, so they come in through the paste form and get tagged here.
// Go Fractional sits behind a login and bot detection, so the email route is the
// reliable way to capture its roles.
const EMAIL_SOURCES = [
  "Go Fractional",
  "LinkedIn",
  "Indeed",
  "Fractional Pulse",
  "Fractional Jobs",
  "Bolster",
  "Other"
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripHtml(s) {
  return String(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeUrl(u) {
  if (!u) return "";
  try {
    const parsed = new URL(u);
    return (parsed.origin + parsed.pathname).replace(/\/+$/, "").toLowerCase();
  } catch (err) {
    return String(u).trim().toLowerCase();
  }
}

function looksRelevant(role) {
  const hay = (role.title + " " + role.description).toLowerCase();
  return KEYWORDS.some((k) => hay.includes(k));
}

function keywordScore(role) {
  const hay = (role.title + " " + role.description).toLowerCase();
  let score = 3;
  if (hay.includes("customer success") || hay.includes("customer experience")) score += 2;
  if (hay.includes("vp") || hay.includes("head of") || hay.includes("chief") || hay.includes("director")) score += 2;
  if (hay.includes("fractional") || hay.includes("interim") || hay.includes("part time")) score += 2;
  if (score > 10) score = 10;
  return {
    fit_score: score,
    fit_reasons: "Keyword fallback score (no Groq key set).",
    intro_note: ""
  };
}

// ---------------------------------------------------------------------------
// Groq scoring and intro note
// ---------------------------------------------------------------------------

async function scoreRole(role) {
  if (!groq) return keywordScore(role);

  const system =
    "You screen job postings for one person and return strict JSON only. " +
    "No markdown, no code fences, no commentary. " +
    "The person you screen for: " + PROFILE + " " +
    "When fit_score is 8 or higher, write an intro_note in this voice: " + WRITING_STYLE + " " +
    "When fit_score is below 8, set intro_note to an empty string. " +
    "Return this exact shape: " +
    '{"fit_score": <integer 1 to 10>, "fit_reasons": "<one short sentence, max 220 chars>", "intro_note": "<string>"}';

  const user =
    "Title: " + (role.title || "") + "\n" +
    "Company: " + (role.company || "unknown") + "\n" +
    "Location: " + (role.location || "") + "\n" +
    "Comp: " + (role.comp_text || "") + "\n" +
    "Description: " + (role.description || "").slice(0, 2500);

  try {
    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      temperature: 0.2,
      max_tokens: 700,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });
    const text = completion.choices[0].message.content || "";
    const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    let score = parseInt(parsed.fit_score, 10);
    if (isNaN(score)) score = 0;
    if (score < 1) score = 1;
    if (score > 10) score = 10;
    return {
      fit_score: score,
      fit_reasons: String(parsed.fit_reasons || "").slice(0, 300),
      intro_note: String(parsed.intro_note || "")
    };
  } catch (err) {
    console.log("Groq scoring failed, using fallback:", err.message);
    return keywordScore(role);
  }
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

async function sendSms(text) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !ALERT_SMS_FROM || !ALERT_SMS_TO) return;
  try {
    const auth = Buffer.from(TWILIO_ACCOUNT_SID + ":" + TWILIO_AUTH_TOKEN).toString("base64");
    const params = new URLSearchParams();
    params.append("To", ALERT_SMS_TO);
    params.append("From", ALERT_SMS_FROM);
    params.append("Body", text.slice(0, 600));
    await fetch("https://api.twilio.com/2010-04-01/Accounts/" + TWILIO_ACCOUNT_SID + "/Messages.json", {
      method: "POST",
      headers: {
        "Authorization": "Basic " + auth,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });
  } catch (err) {
    console.log("SMS send failed:", err.message);
  }
}

async function sendEmail(subject, html) {
  if (!RESEND_API_KEY || !ALERT_EMAIL_FROM || !ALERT_EMAIL_TO) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + RESEND_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: ALERT_EMAIL_FROM,
        to: ALERT_EMAIL_TO,
        subject: subject,
        html: html
      })
    });
  } catch (err) {
    console.log("Email send failed:", err.message);
  }
}

async function alertRole(role) {
  const lines = [
    "JobSignal " + role.fit_score + "/10",
    role.title + (role.company ? " at " + role.company : ""),
    role.location || "",
    role.url || ""
  ].filter(Boolean);
  await sendSms(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sources (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      type TEXT,
      last_checked TIMESTAMPTZ,
      last_status TEXT,
      total_found INTEGER DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS roles (
      id SERIAL PRIMARY KEY,
      source TEXT,
      url TEXT,
      dedupe_key TEXT UNIQUE,
      title TEXT,
      company TEXT,
      location TEXT,
      remote_flag BOOLEAN DEFAULT TRUE,
      comp_text TEXT,
      posted_at TIMESTAMPTZ,
      first_seen_at TIMESTAMPTZ DEFAULT NOW(),
      description TEXT,
      fit_score INTEGER DEFAULT 0,
      fit_reasons TEXT,
      draft_text TEXT,
      status TEXT DEFAULT 'new',
      alerted BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS raw_signals (
      id SERIAL PRIMARY KEY,
      channel TEXT,
      received_at TIMESTAMPTZ DEFAULT NOW(),
      raw_subject TEXT,
      raw_body TEXT,
      processed BOOLEAN DEFAULT FALSE
    );
  `);
  console.log("Schema ready");
}

// Register the marketplace and email sources so they appear in source tracking
// even before their first email arrives.
async function ensureEmailSources() {
  for (const name of EMAIL_SOURCES) {
    if (name === "Other") continue;
    await pool.query(
      `INSERT INTO sources (name, type) VALUES ($1, 'email')
       ON CONFLICT (name) DO NOTHING`,
      [name]
    );
  }
}

// ---------------------------------------------------------------------------
// Ingest one normalized role: dedupe, score, store, alert
// ---------------------------------------------------------------------------

async function ingestRole(sourceName, role) {
  if (!role || !role.title) return { skipped: "no title" };
  if (!looksRelevant(role)) return { skipped: "not relevant" };

  const key = normalizeUrl(role.url) || (sourceName + "|" + (role.company || "") + "|" + role.title).toLowerCase();

  // Skip cross board duplicates of the same company and title seen recently.
  if (role.company) {
    const dupe = await pool.query(
      "SELECT 1 FROM roles WHERE lower(company) = lower($1) AND lower(title) = lower($2) AND first_seen_at > NOW() - INTERVAL '30 days' LIMIT 1",
      [role.company, role.title]
    );
    if (dupe.rowCount > 0) return { skipped: "duplicate" };
  }

  // Skip if we already have this exact url.
  const exists = await pool.query("SELECT 1 FROM roles WHERE dedupe_key = $1 LIMIT 1", [key]);
  if (exists.rowCount > 0) return { skipped: "seen" };

  const scored = await scoreRole(role);

  const inserted = await pool.query(
    `INSERT INTO roles
      (source, url, dedupe_key, title, company, location, remote_flag, comp_text, posted_at, description, fit_score, fit_reasons, draft_text)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      sourceName,
      role.url || "",
      key,
      role.title,
      role.company || "",
      role.location || "",
      role.remote_flag !== false,
      role.comp_text || "",
      role.posted_at || null,
      role.description || "",
      scored.fit_score,
      scored.fit_reasons,
      scored.intro_note || ""
    ]
  );

  if (inserted.rowCount === 0) return { skipped: "race" };

  const id = inserted.rows[0].id;

  if (scored.fit_score >= ALERT_THRESHOLD) {
    await alertRole({
      fit_score: scored.fit_score,
      title: role.title,
      company: role.company,
      location: role.location,
      fit_reasons: scored.fit_reasons,
      url: role.url
    });
    await pool.query("UPDATE roles SET alerted = TRUE WHERE id = $1", [id]);
  }

  return { added: id, score: scored.fit_score };
}

// ---------------------------------------------------------------------------
// Poll all feed sources
// ---------------------------------------------------------------------------

async function pollSources() {
  let added = 0;
  for (const src of SOURCES) {
    let status = "ok";
    let count = 0;
    try {
      const items = await src.fetch();
      for (const item of items) {
        const result = await ingestRole(src.name, item);
        if (result.added) added += 1;
        count += 1;
      }
    } catch (err) {
      status = "error: " + err.message;
      console.log("Source failed:", src.name, err.message);
    }
    await pool.query(
      `INSERT INTO sources (name, type, last_checked, last_status, total_found)
       VALUES ($1,$2,NOW(),$3,$4)
       ON CONFLICT (name) DO UPDATE SET last_checked = NOW(), last_status = $3, type = $2`,
      [src.name, src.type, status, count]
    );
  }
  console.log("Poll complete, added " + added + " new roles");
  return added;
}

// ---------------------------------------------------------------------------
// Parse a pasted alert email into roles using Groq, then ingest each
// ---------------------------------------------------------------------------

async function ingestEmail(subject, body, sourceName) {
  const tag = sourceName || "Email paste";
  await pool.query(
    "INSERT INTO raw_signals (channel, raw_subject, raw_body) VALUES ($1,$2,$3)",
    ["email:" + tag, subject || "", body || ""]
  );

  if (!groq) {
    // Without Groq we cannot reliably split an email, so store one rough role.
    return ingestRole(tag, {
      url: "",
      title: subject || "Pasted email role",
      company: "",
      location: "",
      description: body || ""
    });
  }

  const system =
    "Extract every distinct job posting from this alert email. Return strict JSON only, no markdown. " +
    'Shape: {"roles":[{"title":"","company":"","location":"","url":"","description":""}]}. ' +
    "If there are no real job postings, return an empty roles array.";

  try {
    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      temperature: 0.1,
      max_tokens: 1500,
      messages: [
        { role: "system", content: system },
        { role: "user", content: ("Subject: " + (subject || "") + "\n\n" + (body || "")).slice(0, 9000) }
      ]
    });
    const text = completion.choices[0].message.content || "";
    const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    const roles = Array.isArray(parsed.roles) ? parsed.roles : [];
    let added = 0;
    for (const r of roles) {
      const result = await ingestRole(tag, {
        url: r.url || "",
        title: r.title || "",
        company: r.company || "",
        location: r.location || "",
        description: r.description || ""
      });
      if (result.added) added += 1;
    }
    return { parsed: roles.length, added: added };
  } catch (err) {
    console.log("Email parse failed:", err.message);
    return { error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));

function checkAuth(req, res, next) {
  if (!DASHBOARD_PASSWORD) return next();
  const header = req.headers.authorization || "";
  const token = header.split(" ")[1] || "";
  const decoded = Buffer.from(token, "base64").toString();
  const pass = decoded.split(":")[1] || "";
  if (pass === DASHBOARD_PASSWORD) return next();
  res.set("WWW-Authenticate", 'Basic realm="JobSignal"');
  return res.status(401).send("Authentication required");
}

function cronAuth(req, res, next) {
  if (CRON_SECRET && req.query.key !== CRON_SECRET) {
    return res.status(403).send("Forbidden");
  }
  next();
}

app.get("/health", (req, res) => res.json({ ok: true, groq: !!groq, time: new Date().toISOString() }));

app.get("/cron/poll", cronAuth, async (req, res) => {
  try {
    const added = await pollSources();
    res.json({ ok: true, added: added });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/cron/digest", cronAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT title, company, location, fit_score, url FROM roles WHERE status = 'new' AND first_seen_at > NOW() - INTERVAL '1 day' ORDER BY fit_score DESC LIMIT 40"
    );
    if (result.rowCount === 0) return res.json({ ok: true, sent: 0 });
    const rows = result.rows
      .map((r) => "<p><b>" + r.fit_score + "/10</b> " + escapeHtml(r.title) + (r.company ? " at " + escapeHtml(r.company) : "") + " (" + escapeHtml(r.location || "") + ")<br><a href=\"" + escapeHtml(r.url || "") + "\">View</a></p>")
      .join("");
    await sendEmail("JobSignal daily digest: " + result.rowCount + " new roles", rows);
    res.json({ ok: true, sent: result.rowCount });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/ingest/email", checkAuth, async (req, res) => {
  try {
    const subject = req.body.subject || "";
    const body = req.body.body || "";
    const source = (req.body.source || "Email paste").slice(0, 40);
    const fromForm = req.body.web === "1";
    if (!body) {
      if (fromForm) return res.redirect("/paste?error=1");
      return res.status(400).json({ ok: false, error: "body required" });
    }
    const result = await ingestEmail(subject, body, source);
    if (fromForm) {
      const added = result && result.added ? result.added : 0;
      const parsed = result && result.parsed ? result.parsed : 0;
      return res.redirect("/paste?added=" + added + "&parsed=" + parsed);
    }
    res.json({ ok: true, result: result });
  } catch (err) {
    console.log("Email ingest failed:", err.message);
    if (req.body.web === "1") return res.redirect("/paste?error=1");
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/paste", checkAuth, (req, res) => {
  res.send(renderPasteForm(req.query));
});

app.post("/roles/:id/status", checkAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const status = (req.body.status || "").slice(0, 20);
    await pool.query("UPDATE roles SET status = $1, updated_at = NOW() WHERE id = $2", [status, id]);
    res.redirect("/");
  } catch (err) {
    console.log("Status update failed:", err.message);
    res.status(500).send("Could not update that role. Refresh and try again.");
  }
});

app.get("/", checkAuth, async (req, res) => {
  try {
    const filter = req.query.status || "active";
    let where = "";
    if (filter === "active") where = "WHERE status IN ('new','reviewed')";
    else if (filter === "all") where = "";
    else where = "WHERE status = " + "'" + filter.replace(/[^a-z]/g, "") + "'";

    const result = await pool.query(
      "SELECT id, source, url, title, company, location, comp_text, fit_score, fit_reasons, draft_text, status, first_seen_at FROM roles " +
      where + " ORDER BY fit_score DESC, first_seen_at DESC LIMIT 200"
    );
    res.send(renderDashboard(result.rows, filter));
  } catch (err) {
    console.log("Dashboard query failed:", err.message);
    res.status(500).send("Database not reachable yet. Check the DATABASE_URL value, then refresh.");
  }
});

// ---------------------------------------------------------------------------
// Dashboard rendering. Navy brand, fit score is the organizing element.
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scoreColor(score) {
  if (score >= 8) return "#1f9d55";
  if (score >= 5) return "#b7791f";
  return "#718096";
}

function renderDashboard(rows, filter) {
  const tabs = ["active", "applied", "passed", "all"]
    .map((t) => '<a class="tab' + (t === filter ? " on" : "") + '" href="/?status=' + t + '">' + t + "</a>")
    .join("");

  const cards = rows.map((r) => {
    const draft = r.draft_text
      ? '<details class="draft"><summary>Intro note</summary><pre>' + escapeHtml(r.draft_text) + "</pre></details>"
      : "";
    return (
      '<div class="card">' +
        '<div class="score" style="background:' + scoreColor(r.fit_score) + '">' + r.fit_score + "</div>" +
        '<div class="body">' +
          '<div class="title">' + escapeHtml(r.title) + "</div>" +
          '<div class="meta">' + escapeHtml(r.company || "Company unknown") + " &middot; " + escapeHtml(r.location || "") +
            (r.comp_text ? " &middot; " + escapeHtml(r.comp_text) : "") + "</div>" +
          '<div class="reasons">' + escapeHtml(r.fit_reasons || "") + "</div>" +
          (r.url ? '<a class="link" href="' + escapeHtml(r.url) + '" target="_blank" rel="noopener">Open posting</a>' : "") +
          '<span class="src">' + escapeHtml(r.source || "") + "</span>" +
          draft +
          '<div class="actions">' +
            statusButton(r.id, "applied", r.status) +
            statusButton(r.id, "passed", r.status) +
            statusButton(r.id, "reviewed", r.status) +
          "</div>" +
        "</div>" +
      "</div>"
    );
  }).join("");

  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<title>JobSignal</title>" +
    "<style>" +
    ":root{--navy:#0F2C57;--ink:#1a202c;--soft:#718096;--line:#e2e8f0;--bg:#f7fafc}" +
    "*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg)}" +
    "header{background:var(--navy);color:#fff;padding:18px 20px}" +
    "header h1{margin:0;font-size:18px;letter-spacing:.3px}" +
    "header p{margin:4px 0 0;font-size:13px;color:#b9c6dd}" +
    "header .headlink{display:inline-block;margin-top:10px;color:#fff;font-size:13px;font-weight:600;text-decoration:underline}" +
    ".tabs{display:flex;gap:6px;padding:14px 20px;flex-wrap:wrap}" +
    ".tab{padding:6px 14px;border-radius:999px;background:#fff;border:1px solid var(--line);color:var(--soft);text-decoration:none;font-size:13px;text-transform:capitalize}" +
    ".tab.on{background:var(--navy);color:#fff;border-color:var(--navy)}" +
    ".wrap{padding:0 20px 60px;max-width:760px;margin:0 auto}" +
    ".card{display:flex;gap:14px;background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}" +
    ".score{flex:0 0 46px;height:46px;border-radius:10px;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px}" +
    ".body{flex:1;min-width:0}" +
    ".title{font-weight:600;font-size:15px;line-height:1.3}" +
    ".meta{color:var(--soft);font-size:13px;margin-top:3px}" +
    ".reasons{font-size:13px;margin-top:6px;color:#2d3748}" +
    ".link{display:inline-block;margin-top:8px;margin-right:10px;color:var(--navy);font-size:13px;font-weight:600;text-decoration:none}" +
    ".src{font-size:11px;color:var(--soft)}" +
    ".draft{margin-top:8px}.draft summary{cursor:pointer;font-size:13px;color:var(--navy)}" +
    ".draft pre{white-space:pre-wrap;font-family:inherit;font-size:13px;background:var(--bg);padding:10px;border-radius:8px;margin-top:6px}" +
    ".actions{margin-top:10px;display:flex;gap:8px}" +
    ".actions button{border:1px solid var(--line);background:#fff;border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;color:var(--ink)}" +
    ".actions button.on{background:var(--navy);color:#fff;border-color:var(--navy)}" +
    ".empty{padding:40px 0;text-align:center;color:var(--soft)}" +
    "</style></head><body>" +
    "<header><h1>JobSignal</h1><p>Fractional and interim Customer Success roles, scored against your profile.</p><a class=\"headlink\" href=\"/paste\">Paste an alert email</a></header>" +
    '<div class="tabs">' + tabs + "</div>" +
    '<div class="wrap">' +
    (rows.length ? cards : '<div class="empty">No roles here yet. Trigger a poll or paste an alert email to fill it.</div>') +
    "</div></body></html>"
  );
}

function statusButton(id, status, current) {
  const on = current === status ? " on" : "";
  return (
    '<form method="post" action="/roles/' + id + '/status" style="display:inline">' +
    '<input type="hidden" name="status" value="' + status + '">' +
    '<button class="' + on.trim() + '" type="submit">' + status + "</button></form>"
  );
}

function renderPasteForm(query) {
  let banner = "";
  if (query && query.added !== undefined) {
    banner = '<div class="banner ok">Parsed ' + escapeHtml(query.parsed || "0") + " posting(s), added " + escapeHtml(query.added || "0") + " new. The strong ones already pinged you.</div>";
  } else if (query && query.error) {
    banner = '<div class="banner err">Nothing to read there. Paste the email body and try again.</div>';
  }

  const options = EMAIL_SOURCES
    .map((s) => '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + "</option>")
    .join("");

  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<title>Paste alert email</title>" +
    "<style>" +
    ":root{--navy:#0F2C57;--ink:#1a202c;--soft:#718096;--line:#e2e8f0;--bg:#f7fafc}" +
    "*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg)}" +
    "header{background:var(--navy);color:#fff;padding:18px 20px}" +
    "header h1{margin:0;font-size:18px}header a{color:#fff;font-size:13px;text-decoration:underline}" +
    ".wrap{padding:18px 20px 60px;max-width:640px;margin:0 auto}" +
    ".banner{padding:12px 14px;border-radius:10px;margin-bottom:16px;font-size:14px}" +
    ".banner.ok{background:#e6f6ec;color:#1f7a44}.banner.err{background:#fdecec;color:#a02626}" +
    "label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}" +
    "select,input,textarea{width:100%;padding:11px;border:1px solid var(--line);border-radius:10px;font-size:15px;font-family:inherit;background:#fff}" +
    "textarea{min-height:240px;resize:vertical}" +
    "button{margin-top:18px;width:100%;background:var(--navy);color:#fff;border:0;border-radius:10px;padding:14px;font-size:15px;font-weight:600;cursor:pointer}" +
    ".hint{font-size:13px;color:var(--soft);margin-top:8px;line-height:1.5}" +
    "</style></head><body>" +
    "<header><h1>Paste an alert email</h1><div><a href=\"/\">Back to dashboard</a></div></header>" +
    '<div class="wrap">' + banner +
    '<form method="post" action="/ingest/email">' +
    '<input type="hidden" name="web" value="1">' +
    "<label>Source</label><select name=\"source\">" + options + "</select>" +
    "<label>Subject (optional)</label><input name=\"subject\" placeholder=\"Email subject line\">" +
    "<label>Email body</label><textarea name=\"body\" placeholder=\"Paste the full email here\"></textarea>" +
    "<button type=\"submit\">Scan and score</button>" +
    "</form>" +
    '<p class="hint">Open the alert email, select all, copy, and paste it above. Groq pulls out each ' +
    "posting, scores it against your profile, and pings you on anything that lands at " + ALERT_THRESHOLD + " or higher.</p>" +
    "</div></body></html>"
  );
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  try {
    await ensureSchema();
    await ensureEmailSources();
  } catch (err) {
    console.log("Schema setup failed on boot, will retry on first poll:", err.message);
  }

  if (RUN_INTERNAL_CRON) {
    // Backup scheduler for when the service runs always on.
    // On Render free tier the service sleeps, so the external ping to /cron/poll is what keeps it reliable.
    cron.schedule("*/20 * * * *", async () => {
      try {
        await pollSources();
      } catch (err) {
        console.log("Internal cron poll failed:", err.message);
      }
    });
  }

  app.listen(PORT, () => console.log("JobSignal listening on port " + PORT));
}

boot();
