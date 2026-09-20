#!/usr/bin/env node
// SF neighborhood events scraper — v1
// Pulls upcoming events from five sources, normalizes them to one shape,
// drops private + past events, tags categories, dedupes, sorts, and writes events.json.
//
// Run:  node scrape.mjs           (Faight + Madrone work with no setup)
//       GOOGLE_API_KEY=xxx node scrape.mjs   (also pulls the 3 Google Calendars)
//
// Node 18+ (uses global fetch). No dependencies.

import { writeFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TZ = "America/Los_Angeles";
const DAYS_AHEAD = 35; // how far out to pull calendar events

const SANITY = { project: "3l1powkg", dataset: "production", venue: "The Faight" };

const DOTHEBAY_VENUES = [
  { slug: "madrone-art-bar" }, // add more DoTheBay venue slugs here
];

// Lower Haight Local is NOT here on purpose. Their public Google Calendar
// (the "add to calendar" link on lowerhaightlocal.com) only holds the zine
// production schedule; the neighborhood listings live on the events page.
const GCALS = [
  { source: "Wave Collective",    venue: "Wave Collective", id: "k5bmnva5i30lo1id9kovrvjc4g@group.calendar.google.com" },
  { source: "Gather SF",          venue: null,              id: "0cb73e0cfb94515e2121d1abb6489a84e79133780b7d7c1a5ebba0668340f9a9@group.calendar.google.com" },
];

const LHL_URL = "https://www.lowerhaightlocal.com/events";

// Our category vocabulary
const CATEGORIES = ["Music", "Arts & Performance", "Nightlife", "Community & Social", "Fitness & Dance", "Cultural"];

// ---------------------------------------------------------------------------
// Helpers: time / timezone (everything normalized to America/Los_Angeles)
// ---------------------------------------------------------------------------
function laParts(iso, allDay = false) {
  if (allDay) return { date: iso.slice(0, 10), minutes: -1, timeLabel: "All day" };
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  let hour = +p.hour % 24; // en-CA can emit "24" at midnight
  const minute = +p.minute;
  const date = `${p.year}-${p.month}-${p.day}`;
  const mer = hour >= 12 ? "PM" : "AM";
  let h12 = hour % 12; if (h12 === 0) h12 = 12;
  const timeLabel = minute ? `${h12}:${String(minute).padStart(2, "0")} ${mer}` : `${h12} ${mer}`;
  return { date, minutes: hour * 60 + minute, timeLabel };
}

function todayLA() {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function stripHtml(s = "") {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;|&apos;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Global normalization rules
// ---------------------------------------------------------------------------
const PRIVATE_RE = /\b(private|buyout|closed)\b/i;
const isPrivate = (title = "") => PRIVATE_RE.test(title);

// Keyword categorizer for sources with no category field (Sanity, Google Calendar).
function categorize(title = "", desc = "", fallback = ["Community & Social"]) {
  const t = `${title} ${desc}`.toLowerCase();
  const cats = new Set();
  if (/\b(dj|dance party|club night|nightlife|disco|rave|late[- ]night)\b/.test(t)) cats.add("Nightlife");
  if (/\b(music|band|live set|concert|singer|songwriter|jazz|rock|folk|indie|album|tour|acoustic|vinyl|record release|headline)\b/.test(t)) cats.add("Music");
  if (/\b(yoga|dance lesson|line danc|running|run club|workout|fitness|qi ?gong|tai chi|movement|pilates|hike|hiking)\b/.test(t)) cats.add("Fitness & Dance");
  if (/\b(art|drag|theat(er|re)|comedy|poetry|reading|writing|gallery|exhibit|opening|film|screening|performance|paint)\b/.test(t)) cats.add("Arts & Performance");
  if (/\b(festival|street fair|block party|cultural|heritage|lunar|mooncake|holiday|halloween|pride|day of the dead)\b/.test(t)) cats.add("Cultural");
  if (/\b(open mic|trivia|bingo|game night|cleanup|clean-up|meetup|community|market|volunteer|workshop|\btea\b|coffee)\b/.test(t)) cats.add("Community & Social");
  return cats.size ? [...cats] : [...fallback];
}

// DoTheBay category_param -> our vocabulary
const DTB_MAP = {
  music: ["Music"],
  nightlife: ["Nightlife"],
  "the-arts": ["Arts & Performance"],
  "theatre-performing-arts": ["Arts & Performance"],
  comedy: ["Arts & Performance"],
  film: ["Arts & Performance"],
  literature: ["Arts & Performance", "Community & Social"],
  festivals: ["Cultural"],
  "food-drink": ["Community & Social"],
  community: ["Community & Social"],
  "sports-active-life": ["Fitness & Dance"],
};

// ---------------------------------------------------------------------------
// Source: The Faight (public Sanity CMS)
// ---------------------------------------------------------------------------
async function fetchFaight() {
  const nowIso = new Date().toISOString();
  const groq = `*[_type=="event" && status=="published" && !isPrivate && startTime > "${nowIso}"]|order(startTime asc){title,startTime,endTime,ctaUrl,"desc":pt::text(description),"slug":slug.current}`;
  const url = `https://${SANITY.project}.apicdn.sanity.io/v2021-10-21/data/query/${SANITY.dataset}?query=${encodeURIComponent(groq)}`;
  const { result = [] } = await (await fetch(url)).json();
  return result.map((e) => {
    const { date, minutes, timeLabel } = laParts(e.startTime);
    return {
      source: "The Faight",
      venue: "The Faight",
      title: e.title,
      description: e.desc || "",
      date, startMinutes: minutes, timeLabel,
      url: e.ctaUrl || "https://www.thefaight.com/events",
      free: null, // Faight doesn't expose price in the CMS; usually ticketed
      categories: categorize(e.title, e.desc, ["Music"]),
    };
  });
}

// ---------------------------------------------------------------------------
// Source: DoTheBay venue feed (works for any venue on DoTheBay / Do415)
// ---------------------------------------------------------------------------
async function fetchDoTheBay(slug) {
  const data = await (await fetch(`https://dothebay.com/venues/${slug}.json`)).json();
  const venueName = data?.venue?.title || slug;
  const events = (data.event_groups || []).flatMap((g) => g.events || []).filter((e) => !e.past);
  return events.map((e) => {
    const { date, minutes, timeLabel } = laParts(e.tz_adjusted_begin_date || e.begin_time);
    const cats = DTB_MAP[e.category_param] || categorize(e.title, stripHtml(e.description || e.excerpt), ["Community & Social"]);
    return {
      source: "DoTheBay",
      venue: venueName,
      title: e.title,
      description: stripHtml(e.description || e.excerpt || ""),
      date, startMinutes: minutes, timeLabel,
      url: "https://dothebay.com" + e.permalink,
      free: !!e.is_free,
      categories: cats,
    };
  });
}

// ---------------------------------------------------------------------------
// Source: Lower Haight Local (Astro site; events are server-rendered into the
// hydration props of the events-page island, so no HTML scraping needed).
// ---------------------------------------------------------------------------
function unescapeAttr(s) {
  return s
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// Astro serializes each prop as [type, value]; 0 = plain/object, 1 = array.
// The rest are exotic types this page doesn't use, passed through as-is.
function reviveAstro(node) {
  if (!Array.isArray(node) || node.length !== 2) return node;
  const [type, value] = node;
  if (type === 1) return Array.isArray(value) ? value.map(reviveAstro) : value;
  if (type !== 0) return value;
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map(reviveAstro);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, reviveAstro(v)]));
}

// "10:00 AM - 11:00 AM" / "7 PM" -> minutes since midnight, or -1 if unparseable.
function parseTimeLabel(label = "") {
  const m = label.match(/(\d{1,2})(?::(\d{2}))?\s*([APap])\.?[Mm]/);
  if (!m) return -1;
  let h = +m[1] % 12;
  if (m[3].toLowerCase() === "p") h += 12;
  return h * 60 + (m[2] ? +m[2] : 0);
}

async function fetchLowerHaightLocal() {
  const html = await (await fetch(LHL_URL)).text();
  const islands = [...html.matchAll(/<astro-island\b[^>]*\bprops="([^"]*)"/g)];
  let grouped = null;
  for (const [, raw] of islands) {
    const props = JSON.parse(unescapeAttr(raw));
    if (props.initialGroupedEvents) {
      grouped = reviveAstro(props.initialGroupedEvents);
      break;
    }
  }
  if (!grouped) throw new Error("no initialGroupedEvents island found");

  const today = todayLA();
  return Object.values(grouped).flat().filter((e) => e?.date >= today).map((e) => {
    const minutes = parseTimeLabel(e.time);
    return {
      source: "Lower Haight Local",
      venue: (e.location || "").split(",")[0].trim() || "Lower Haight",
      title: e.title,
      description: stripHtml(e.description || ""),
      date: e.date,
      startMinutes: minutes,
      timeLabel: e.time || "Time TBA",
      url: e.url || e.link || LHL_URL,
      free: typeof e.isFree === "boolean" ? e.isFree : null,
      categories: categorize(e.title, e.description),
    };
  });
}

// ---------------------------------------------------------------------------
// Source: Google Calendar (public) via Calendar API v3
// Needs GOOGLE_API_KEY. See README for the 2-minute setup.
// ---------------------------------------------------------------------------
async function fetchGCal(cal, apiKey) {
  // Anchor to the start of today rather than "now", or events that already
  // started today are dropped before the UI (which opens on today) sees them.
  // UTC midnight is 7-8h ahead of LA midnight, so this reaches slightly into
  // yesterday; the `date >= todayLA()` filter in main() trims that back off.
  const [y, m, d] = todayLA().split("-").map(Number);
  const timeMin = new Date(Date.UTC(y, m - 1, d)).toISOString();
  const timeMax = new Date(Date.now() + DAYS_AHEAD * 864e5).toISOString();
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`
    + `?key=${apiKey}&singleEvents=true&orderBy=startTime&maxResults=250`
    + `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${cal.source}: HTTP ${res.status} ${(await res.text()).slice(0, 140)}`);
  const { items = [] } = await res.json();
  return items.map((it) => {
    const allDay = !it.start?.dateTime;
    const iso = it.start?.dateTime || it.start?.date;
    const { date, minutes, timeLabel } = laParts(iso, allDay);
    const title = it.summary || "(untitled)";
    return {
      source: cal.source,
      venue: cal.venue || it.location?.split(",")[0] || cal.source,
      title,
      description: (it.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      date, startMinutes: minutes, timeLabel,
      url: it.htmlLink || "",
      free: null,
      categories: categorize(title, it.description, ["Community & Social"]),
    };
  });
}

// ---------------------------------------------------------------------------
// Dedupe: same date + venue + normalized title => one event, sources merged
// ---------------------------------------------------------------------------
const norm = (s = "") => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Already matched on day and venue, so a listing that just qualifies the
// other's title is the same event ("Open Mic" / "Open Mic at The Faight").
const titlesMatch = (a, b) =>
  a === b || (a.length >= 6 && b.length >= 6 && (a.startsWith(b) || b.startsWith(a)));

function dedupe(events) {
  const out = [];
  for (const e of events) {
    const slot = `${e.date}|${norm(e.venue)}`;
    const title = norm(e.title);
    const first = out.find((o) => o._slot === slot && titlesMatch(o._title, title));
    if (first) {
      if (!first.alsoIn.includes(e.source)) first.alsoIn.push(e.source);
    } else {
      out.push({ ...e, alsoIn: [e.source], _slot: slot, _title: title });
    }
  }
  return out.map(({ _slot, _title, ...e }) => e);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const apiKey = process.env.GOOGLE_API_KEY;
  const tasks = [
    ["The Faight (Sanity)", fetchFaight()],
    ...DOTHEBAY_VENUES.map((v) => [`DoTheBay:${v.slug}`, fetchDoTheBay(v.slug)]),
    ["Lower Haight Local", fetchLowerHaightLocal()],
  ];
  if (apiKey) {
    for (const cal of GCALS) tasks.push([cal.source, fetchGCal(cal, apiKey)]);
  } else {
    console.warn("⚠  GOOGLE_API_KEY not set — skipping Wave Collective and Gather SF. See README.");
  }

  let all = [];
  for (const [label, p] of tasks) {
    try {
      const rows = await p;
      console.log(`  ${label}: ${rows.length} events`);
      all.push(...rows);
    } catch (err) {
      console.error(`  ✗ ${label} failed: ${err.message}`);
    }
  }

  const today = todayLA();
  const before = all.length;
  all = all.filter((e) => !isPrivate(e.title));        // drop private
  const droppedPrivate = before - all.length;
  all = all.filter((e) => e.date >= today);            // drop past
  all = dedupe(all);                                   // merge cross-source dups
  all.sort((a, b) => a.date.localeCompare(b.date) || a.startMinutes - b.startMinutes || a.venue.localeCompare(b.venue));

  await writeFile(new URL("./events.json", import.meta.url), JSON.stringify(all, null, 2));
  const dups = all.filter((e) => e.alsoIn.length > 1).length;
  console.log(`\n✓ ${all.length} events written to events.json`);
  console.log(`  (dropped ${droppedPrivate} private, filtered to ${today} onward, ${dups} appear in >1 source)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
