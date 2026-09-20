#!/usr/bin/env node
// SF neighborhood events scraper — v1
// Pulls upcoming events from six sources, normalizes them to one shape,
// drops private + past events, tags categories, dedupes, sorts, and writes events.json.
//
// Run:  node scrape.mjs           (Faight + Madrone + tiat work with no setup)
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

// Public Luma calendars. `id` is the calendar_api_id found in the calendar page's
// embedded JSON — not the vanity slug.
const LUMA_CALENDARS = [
  { source: "tiat", venue: "tiat", id: "cal-twiOosdGMMY66DI", fallback: ["Arts & Performance"] },
];

const GCALS = [
  { source: "Wave Collective",    venue: "Wave Collective", id: "k5bmnva5i30lo1id9kovrvjc4g@group.calendar.google.com" },
  { source: "Lower Haight Local", venue: null,              id: "c355b17347d2721bff62a21b8378d5caa0a717f34a4a465f13a624d85525e6d6@group.calendar.google.com" },
  { source: "Gather SF",          venue: null,              id: "0cb73e0cfb94515e2121d1abb6489a84e79133780b7d7c1a5ebba0668340f9a9@group.calendar.google.com" },
];

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
// Source: Luma calendar (public, no key). Unofficial JSON endpoint — the same one
// the calendar page itself calls. `entries[].event` holds the event; the sibling
// `calendar` object is the calendar that *owns* it, which differs from ours on an
// aggregating calendar like tiat's.
// ---------------------------------------------------------------------------
async function fetchLuma(cal) {
  const entries = [];
  let cursor = null;
  for (let page = 0; page < 5; page++) {
    const url = `https://api.lu.ma/calendar/get-items?calendar_api_id=${encodeURIComponent(cal.id)}`
      + `&period=future&pagination_limit=50`
      + (cursor ? `&pagination_cursor=${encodeURIComponent(cursor)}` : "");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${cal.source}: HTTP ${res.status} ${(await res.text()).slice(0, 140)}`);
    const data = await res.json();
    entries.push(...(data.entries || []));
    // Stop on a repeated cursor too, so an ignored cursor param can't loop forever.
    if (!data.has_more || !data.next_cursor || data.next_cursor === cursor) break;
    cursor = data.next_cursor;
  }

  return entries
    .map((e) => e.event)
    .filter((ev) => ev && ev.location_type !== "virtual")
    .map((ev) => {
      const { date, minutes, timeLabel } = laParts(ev.start_at);
      return {
        source: cal.source,
        venue: cal.venue,
        title: ev.name,
        description: "", // get-items returns no description; only per-event fetches have one
        date, startMinutes: minutes, timeLabel,
        url: `https://luma.com/${ev.url}`,
        free: null,
        categories: categorize(ev.name, "", cal.fallback),
      };
    });
}

// ---------------------------------------------------------------------------
// Source: Google Calendar (public) via Calendar API v3
// Needs GOOGLE_API_KEY. See README for the 2-minute setup.
// ---------------------------------------------------------------------------
async function fetchGCal(cal, apiKey) {
  const timeMin = new Date().toISOString();
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
function dedupe(events) {
  const seen = new Map();
  for (const e of events) {
    const key = `${e.date}|${norm(e.venue)}|${norm(e.title).slice(0, 40)}`;
    if (seen.has(key)) {
      const first = seen.get(key);
      if (!first.alsoIn.includes(e.source)) first.alsoIn.push(e.source);
    } else {
      seen.set(key, { ...e, alsoIn: [e.source] });
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const apiKey = process.env.GOOGLE_API_KEY;
  const tasks = [
    ["The Faight (Sanity)", fetchFaight()],
    ...DOTHEBAY_VENUES.map((v) => [`DoTheBay:${v.slug}`, fetchDoTheBay(v.slug)]),
    ...LUMA_CALENDARS.map((c) => [`Luma:${c.source}`, fetchLuma(c)]),
  ];
  if (apiKey) {
    for (const cal of GCALS) tasks.push([cal.source, fetchGCal(cal, apiKey)]);
  } else {
    console.warn("⚠  GOOGLE_API_KEY not set — skipping Wave Collective, Lower Haight Local, Gather SF. See README.");
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
