#!/usr/bin/env node
// SF neighborhood events scraper — v1
// Pulls upcoming events from six sources, normalizes them to one shape,
// drops private + past events, tags categories, dedupes, sorts, and writes events.json.
//
// Run:  node scrape.mjs           (Faight + Madrone + Gather SF work with no setup)
//       GOOGLE_API_KEY=xxx node scrape.mjs   (also pulls the 3 Google Calendars)
//
// Node 18+ (uses global fetch). No dependencies.

import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TZ = "America/Los_Angeles";
const DAYS_AHEAD = 35; // how far out to pull calendar events
// Some ticket hosts serve an empty shell to unknown agents; identify ourselves.
const UA = "sf-events-scraper (+https://github.com/jenkliu/sf-events)";

const SANITY = { project: "3l1powkg", dataset: "production", venue: "The Faight" };

const DOTHEBAY_VENUES = [
  { slug: "madrone-art-bar" }, // add more DoTheBay venue slugs here
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
  if (/\b(yoga|dance lesson|line danc|running|run club|workout|fitness|qi ?gong|tai chi|movement|pilates|hike|hiking|ecstatic dance|breathwork|somatic)\b/.test(t)) cats.add("Fitness & Dance");
  if (/\b(art|drag|theat(er|re)|comedy|poetry|reading|writing|gallery|exhibit|opening|film|screening|performance|paint)\b/.test(t)) cats.add("Arts & Performance");
  if (/\b(festival|street fair|block party|cultural|heritage|lunar|mooncake|holiday|halloween|pride|day of the dead|ceremony|cacao|kirtan|solstice|equinox|new moon|full moon)\b/.test(t)) cats.add("Cultural");
  if (/\b(open mic|trivia|bingo|game night|cleanup|clean-up|meetup|community|market|volunteer|workshop|\btea\b|teahouse|coffee|sound bath|meditat\w*|mandala|potluck|circle)\b/.test(t)) cats.add("Community & Social");
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
// Source: Gather SF (https://www.gathersf.org/events)
// A Framer page that lists pop-ups and links each one out to its ticket page
// (Luma / Partiful / Eventbrite). Those hosts publish schema.org JSON-LD, so:
//   1. read any Event JSON-LD on the events page itself, then
//   2. follow the event links and read the JSON-LD (or __NEXT_DATA__) there.
// No API key needed — this is the keyless route to Gather SF; the public Google
// Calendar in GCALS covers the same org when GOOGLE_API_KEY is set (deduped).
// ---------------------------------------------------------------------------
const GATHER = {
  source: "Gather SF",
  venue: "Gather SF",
  // GATHER_SF_URL overrides the page (used by the tests to point at a fixture).
  page: process.env.GATHER_SF_URL || "https://www.gathersf.org/events",
  maxLinks: 30, // cap on event pages followed per run
};

// Ticket hosts worth following: each renders a real event page with JSON-LD.
const TICKET_HOSTS = [
  { re: /^https?:\/\/(?:www\.)?lu\.ma\/([\w-]+)\/?(?:[?#]|$)/i,          skip: /^(?:user|u|signin|login|discover|home|create|pricing|about|terms|privacy|help)$/i },
  { re: /^https?:\/\/(?:www\.)?luma\.com\/([\w-]+)\/?(?:[?#]|$)/i,       skip: /^(?:user|u|signin|login|discover|home|create|pricing|about|terms|privacy|help)$/i },
  { re: /^https?:\/\/(?:www\.)?partiful\.com\/e\/([\w-]+)\/?(?:[?#]|$)/i },
  { re: /^https?:\/\/(?:www\.)?eventbrite\.com\/e\/([\w-]+)\/?(?:[?#]|$)/i },
];

// --- generic structured-data readers (reused for every ticket host) --------

// Every <script type="application/ld+json"> on the page, flattened (@graph too).
export function extractJsonLd(html = "") {
  const nodes = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const raw = m[1].trim().replace(/^<!--/, "").replace(/-->$/, "").trim();
    try { nodes.push(...flattenLd(JSON.parse(raw))); } catch { /* skip malformed blocks */ }
  }
  return nodes;
}

function flattenLd(node) {
  if (Array.isArray(node)) return node.flatMap(flattenLd);
  if (!node || typeof node !== "object") return [];
  const graph = Array.isArray(node["@graph"]) ? node["@graph"].flatMap(flattenLd) : [];
  return [node, ...graph];
}

// Matches Event and its subtypes (SocialEvent, MusicEvent, EducationEvent, ...).
export function isLdEvent(node) {
  const t = node?.["@type"];
  return (Array.isArray(t) ? t : [t]).some((x) => typeof x === "string" && /event$/i.test(x));
}

function ldPlace(loc) {
  if (!loc) return null;
  const first = Array.isArray(loc) ? loc[0] : loc;
  if (typeof first === "string") return stripHtml(first).split(",")[0] || null;
  const name = first?.name || first?.address?.name || first?.address?.streetAddress;
  return typeof name === "string" ? stripHtml(name).split(",")[0] || null : null;
}

// true = every offer is $0, false = something costs money, null = no price info.
function ldFree(node) {
  const prices = [].concat(node?.offers || [])
    .map((o) => Number(o?.price ?? o?.lowPrice))
    .filter((n) => Number.isFinite(n));
  return prices.length ? prices.every((p) => p === 0) : null;
}

// JSON-LD Event -> our normalized shape (minus source/venue defaults).
export function eventFromLd(node, fallbackUrl = "") {
  const start = typeof node?.startDate === "string" ? node.startDate : "";
  const title = stripHtml(typeof node?.name === "string" ? node.name : "");
  if (!start || !title) return null;
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(start);
  if (!allDay && Number.isNaN(Date.parse(start))) return null;
  const { date, minutes, timeLabel } = laParts(start, allDay);
  const description = stripHtml(typeof node?.description === "string" ? node.description : "");
  return {
    title,
    description,
    date, startMinutes: minutes, timeLabel,
    url: typeof node?.url === "string" && node.url ? node.url : fallbackUrl,
    free: ldFree(node),
    place: ldPlace(node?.location),
  };
}

// Fallback for Next.js ticket pages (Luma, Partiful) that skip JSON-LD: walk
// __NEXT_DATA__ for objects carrying a name plus a start timestamp.
export function eventsFromNextData(html = "", fallbackUrl = "") {
  const m = html.match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return [];
  let data;
  try { data = JSON.parse(m[1]); } catch { return []; }

  const out = [];
  const seen = new Set();
  (function walk(node, depth) {
    if (!node || typeof node !== "object" || depth > 12) return;
    if (Array.isArray(node)) { for (const v of node) walk(v, depth + 1); return; }
    const title = [node.name, node.title].find((v) => typeof v === "string" && v.trim());
    const start = [node.start_at, node.startAt, node.start_time, node.startDate]
      .find((v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
    if (title && start) {
      const { date, minutes, timeLabel } = laParts(start);
      const key = `${date}|${norm(title)}`;
      if (!seen.has(key)) {
        seen.add(key);
        const place = node.geo_address_info?.city_state || node.geo_address_info?.address
          || (typeof node.location === "string" ? node.location : node.location?.name) || null;
        out.push({
          title: stripHtml(title),
          description: stripHtml(typeof node.description === "string" ? node.description
            : typeof node.description_mirror === "string" ? node.description_mirror : ""),
          date, startMinutes: minutes, timeLabel,
          url: typeof node.url === "string" ? node.url : fallbackUrl,
          free: null,
          place: place ? stripHtml(String(place)).split(",")[0] : null,
        });
      }
    }
    for (const v of Object.values(node)) walk(v, depth + 1);
  })(data, 0);
  return out;
}

// Every ticket-host event link on a page, absolutized and de-duplicated.
export function harvestEventLinks(html = "", base = GATHER.page) {
  const links = new Set();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    let href = m[1].replace(/&amp;/g, "&").trim();
    if (!href || href.startsWith("#") || /^(?:mailto|tel|javascript):/i.test(href)) continue;
    let abs;
    try { abs = new URL(href, base).toString(); } catch { continue; }
    for (const host of TICKET_HOSTS) {
      const hit = abs.match(host.re);
      if (!hit || (host.skip && host.skip.test(hit[1]))) continue;
      // Drop query + hash so tracking params (?tk=...) don't fetch the same event twice.
      const u = new URL(abs);
      links.add(u.origin + u.pathname.replace(/\/$/, ""));
      break;
    }
  }
  return [...links];
}

// --- the source itself ------------------------------------------------------

async function getText(url) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Small concurrency pool so we don't hammer the ticket hosts.
export async function mapPool(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }));
  return out;
}

export async function fetchGatherSF() {
  const html = await getText(GATHER.page);
  const rows = [];

  // 1. Events described on the Gather page itself.
  for (const node of extractJsonLd(html).filter(isLdEvent)) {
    const e = eventFromLd(node, GATHER.page);
    if (e) rows.push(e);
  }

  // 2. Follow the ticket links (Luma / Partiful / Eventbrite) it points at.
  const links = harvestEventLinks(html).slice(0, GATHER.maxLinks);
  const pages = await mapPool(links, 6, async (link) => {
    try {
      return { link, html: await getText(link) };
    } catch (err) {
      console.error(`    ✗ Gather SF: ${link} — ${err.message}`);
      return null;
    }
  });
  for (const page of pages) {
    if (!page) continue;
    const ld = extractJsonLd(page.html).filter(isLdEvent)
      .map((n) => eventFromLd(n, page.link)).filter(Boolean);
    rows.push(...(ld.length ? ld : eventsFromNextData(page.html, page.link)));
  }

  if (!rows.length) console.warn("⚠  Gather SF: no events parsed from the page (it is often empty between pop-ups).");

  const seen = new Set();
  return rows.filter((e) => {
    const key = `${e.date}|${norm(e.title).slice(0, 40)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(({ place, ...e }) => ({
    source: GATHER.source,
    venue: place && !/gather/i.test(place) ? place : GATHER.venue,
    ...e,
    categories: categorize(e.title, e.description, ["Community & Social"]),
  }));
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
// All sources start at once, so a source that fails before we get round to
// awaiting it must already carry a handler — otherwise Node kills the run.
const settle = (p) => p.then((rows) => ({ rows }), (err) => ({ err }));

async function main() {
  const apiKey = process.env.GOOGLE_API_KEY;
  const tasks = [
    ["The Faight (Sanity)", settle(fetchFaight())],
    ...DOTHEBAY_VENUES.map((v) => [`DoTheBay:${v.slug}`, settle(fetchDoTheBay(v.slug))]),
    ["Gather SF (web)", settle(fetchGatherSF())],
  ];
  if (apiKey) {
    for (const cal of GCALS) tasks.push([cal.source, settle(fetchGCal(cal, apiKey))]);
  } else {
    console.warn("⚠  GOOGLE_API_KEY not set — skipping the Google Calendars (Wave Collective, Lower Haight Local, Gather SF's calendar). Gather SF's own page is still pulled. See README.");
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

// Run only when invoked directly — importing this file (e.g. from tests) is side-effect free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
