#!/usr/bin/env node
// SF neighborhood events scraper — v1
// Pulls upcoming events from eight sources, normalizes them to one shape,
// drops private + past events, tags categories, dedupes, sorts, and writes events.json.
//
// Run:  node scrape.mjs           (all but the 3 Google Calendars work with no setup)
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

// Lower Haight Local is NOT here on purpose. Their public Google Calendar
// (the "add to calendar" link on lowerhaightlocal.com) only holds the zine
// production schedule; the neighborhood listings live on the events page.
const GCALS = [
  { source: "Wave Collective",    venue: "Wave Collective", id: "k5bmnva5i30lo1id9kovrvjc4g@group.calendar.google.com" },
  { source: "Gather SF",          venue: null,              id: "0cb73e0cfb94515e2121d1abb6489a84e79133780b7d7c1a5ebba0668340f9a9@group.calendar.google.com" },
  // Civic Joy Fund runs events city-wide (weekly neighborhood cleanups, monthly
  // night markets, street fairs), so each entry brings its own venue. Their
  // events page carries no data of its own — see fetchGCal's note on where this
  // calendar ID comes from, and docs/event-sources.md for how to re-derive it.
  { source: "Civic Joy Fund",     venue: null,              id: "c_b0e78aa2d8125f99b281c06594c1e47e63f1bcb7c33e975f8b6d469204f6735f@group.calendar.google.com", linkFromDescription: true },
];

const LHL_URL = "https://www.lowerhaightlocal.com/events";
const GATHER_URL = "https://www.gathersf.org/events";

// Some ticket hosts serve an empty shell to unknown agents; identify ourselves.
const UA = "sf-events-scraper (+https://github.com/jenkliu/sf-events)";

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
// Source: Gather SF (Framer page — the listing itself carries no event data,
// but every pop-up links out to Luma / Partiful / Eventbrite, and those pages
// publish schema.org Event JSON-LD). Keyless; complements the GCALS entry.
// ---------------------------------------------------------------------------
const TICKET_LINK_RE =
  /https?:\/\/(?:www\.)?(?:lu\.ma\/[\w-]+|luma\.com\/[\w-]+|partiful\.com\/e\/[\w-]+|eventbrite\.com\/e\/[\w-]+)/gi;
// lu.ma paths that are profiles and marketing pages, not events.
const LUMA_NON_EVENT = /lu\.ma\/(?:user|u|signin|login|discover|home|create|pricing|about|terms|privacy|help)$/i;

const flattenLd = (n) =>
  Array.isArray(n) ? n.flatMap(flattenLd)
  : n && typeof n === "object" ? [n, ...flattenLd(n["@graph"] || [])]
  : [];

// Every schema.org Event (or subtype: SocialEvent, MusicEvent, ...) in a page.
function ldEvents(html = "") {
  const out = [];
  for (const m of html.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      out.push(...flattenLd(JSON.parse(m[1].trim())));
    } catch { /* skip malformed blocks */ }
  }
  return out.filter((n) => [].concat(n["@type"] || []).some((t) => /event$/i.test(t)));
}

function ldToEvent(node, pageUrl) {
  const start = typeof node.startDate === "string" ? node.startDate : "";
  const title = stripHtml(typeof node.name === "string" ? node.name : "");
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(start);
  if (!title || !start || (!allDay && Number.isNaN(Date.parse(start)))) return null;
  const { date, minutes, timeLabel } = laParts(start, allDay);
  const description = stripHtml(typeof node.description === "string" ? node.description : "");
  const loc = Array.isArray(node.location) ? node.location[0] : node.location;
  const place = stripHtml(typeof loc === "string" ? loc : loc?.name || "").split(",")[0];
  // Every offer $0 => free, any priced offer => not free, no offers => unknown.
  const prices = [].concat(node.offers || []).map((o) => Number(o?.price)).filter(Number.isFinite);
  return {
    source: "Gather SF",
    venue: place && !/gather/i.test(place) ? place : "Gather SF",
    title,
    description,
    date, startMinutes: minutes, timeLabel,
    url: typeof node.url === "string" && node.url ? node.url : pageUrl,
    free: prices.length ? prices.every((p) => p === 0) : null,
    // Title only: these are essay-length Luma descriptions, and a stray word
    // ("our version of the Tiny Desk Concert") mislabels a tea tasting as Music.
    categories: categorize(title),
  };
}

async function fetchGatherSF() {
  const get = async (url) => {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  };

  // Match the raw HTML rather than href attributes: Framer keeps some link
  // targets in inline JSON, and dropping query strings dedupes ?tk= variants.
  const html = await get(GATHER_URL);
  const links = [...new Set(html.match(TICKET_LINK_RE) || [])]
    .filter((l) => !LUMA_NON_EVENT.test(l))
    .slice(0, 25); // cap the pages we follow per run
  const pages = await Promise.all(links.map((l) => get(l).catch((err) => {
    console.error(`    ✗ Gather SF: ${l} — ${err.message}`);
    return "";
  })));

  const seen = new Set();
  return [[html, GATHER_URL], ...pages.map((h, i) => [h, links[i]])]
    .flatMap(([page, url]) => ldEvents(page).map((n) => ldToEvent(n, url)))
    .filter((e) => {
      if (!e) return false;
      const key = `${e.date}|${norm(e.title)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// ---------------------------------------------------------------------------
// Source: Google Calendar (public) via Calendar API v3
// Needs GOOGLE_API_KEY. See README for the 2-minute setup.
//
// Civic Joy Fund's calendar is reached the same way, but its ID isn't published
// anywhere on their site: civicjoyfund.org/events renders an Elfsight widget,
// whose config (core.service.elfsight.com/p/boot/?w=<widget-id>) names the
// Google Calendar it syncs. docs/event-sources.md walks through that lookup.
// ---------------------------------------------------------------------------

// Google Calendar rewrites links in a description through its own redirector,
// so unwrap those back to where they actually point.
function unwrapGoogleLink(url) {
  const m = url.match(/^https?:\/\/(?:www\.)?google\.com\/url\?(.+)$/i);
  return (m && new URLSearchParams(m[1]).get("q")) || url;
}

// Calendars that keep the real link in the description ("Sign up here: <a ...>")
// opt in with `linkFromDescription`: htmlLink only opens the calendar entry,
// which is a dead end for anyone who wants to RSVP. Google's own links (a map
// pin on the venue) are skipped — they're never the event page.
function descriptionLink(html = "") {
  for (const [, href] of html.matchAll(/href="(https?:\/\/[^"]+)"/gi)) {
    const url = unwrapGoogleLink(href.replace(/&amp;/g, "&"));
    if (!/^https?:\/\/(?:www\.)?google\.com\//i.test(url)) return url;
  }
  return "";
}

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
      url: (cal.linkFromDescription && descriptionLink(it.description)) || it.htmlLink || "",
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
// Every source starts at once, so one that fails before we get round to
// awaiting it must already carry a handler — otherwise Node kills the run.
const settle = (p) => p.then((rows) => ({ rows }), (err) => ({ err }));

async function main() {
  const apiKey = process.env.GOOGLE_API_KEY;
  const tasks = [
    ["The Faight (Sanity)", settle(fetchFaight())],
    ...DOTHEBAY_VENUES.map((v) => [`DoTheBay:${v.slug}`, settle(fetchDoTheBay(v.slug))]),
    ...LUMA_CALENDARS.map((c) => [`Luma:${c.source}`, settle(fetchLuma(c))]),
    ["Lower Haight Local", settle(fetchLowerHaightLocal())],
    ["Gather SF (page)", settle(fetchGatherSF())],
  ];
  if (apiKey) {
    for (const cal of GCALS) tasks.push([cal.source, settle(fetchGCal(cal, apiKey))]);
  } else {
    console.warn("⚠  GOOGLE_API_KEY not set — skipping Wave Collective, Civic Joy Fund and Gather SF's calendar (its events page still works). See README.");
  }

  let all = [];
  for (const [label, p] of tasks) {
    const { rows, err } = await p;
    if (err) {
      console.error(`  ✗ ${label} failed: ${err.message}`);
      continue;
    }
    console.log(`  ${label}: ${rows.length} events`);
    all.push(...rows);
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
