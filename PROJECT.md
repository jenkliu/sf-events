# SF Events — project overview

Aggregate the events happening in SF in the upcoming week into one place, filterable by
category (music, arts & performance, fitness & wellness, volunteering & civic, festivals &
markets, talks & workshops, community & social). Starting as a personal automated task; may
grow into an app with a UI.

## Where things live

- **Scraper** — this repo (`scrape.mjs`). Pulls all sources, normalizes, filters, dedupes,
  writes `events.json`. See `README.md` to run it.
- **Source catalog** — `docs/event-sources.md`: every source evaluated, how to ingest each,
  category coverage, and the recommended build order. Read this before adding sources.
- **Interactive PoC** — a filterable web page ("Lower Haight Marquee") built as a Claude
  artifact, showing real scraped events with date/category/source filters, expandable
  descriptions, and cross-source dedup flags. Private page on claude.ai:
  https://claude.ai/artifact/1pmY8W2ioEfqWx87vddefY
- **Project notes** — the "SF events" Project on claude.ai also holds `event-sources.md`
  (same content as `docs/`), kept in sync there for cross-surface visibility.

## Sources wired up (v1)

| Source | Route | Setup |
|---|---|---|
| The Faight | Sanity CMS API | none |
| Madrone Art Bar | Own calendar's iCal export (`/calendar/<YYYY-MM>/?ical=1`) | none |
| Wave Collective | Google Calendar API | needs `GOOGLE_API_KEY` |
| Lower Haight Local | Events page (Astro props) | none |
| Gather SF | Google Calendar API | needs `GOOGLE_API_KEY` |
| Gather SF (page) | gathersf.org/events → the Luma/Partiful/Eventbrite pages it links | none |
| tiat | Luma `calendar/get-items` JSON | none |
| The Commons | Luma `calendar/get-items` JSON | none |
| Civic Joy Fund | Google Calendar API | needs `GOOGLE_API_KEY` |

## Normalized event shape

`{ source, venue, title, description, date, startMinutes, timeLabel, url, free, categories[], alsoIn[] }`
— sorted by date then start time. `alsoIn.length > 1` means it was de-duplicated across sources;
`source` is then whichever of them the merge kept (the venue's own, where there is one).

## Decisions / gotchas worth remembering

- **No single "all SF events" API.** Blend structured feeds + light scraping, then dedupe.
- **Eventbrite public search API is dead** (since 2020) — scrape or use its per-org API only.
- **Drop private + past events** globally. Wave Collective's calendar is mostly private holds.
- **The Faight `showNotes` field is internal** (artist contact info) — never surface it.
- **Google Calendars: use the API with `singleEvents=true`** so recurring events expand.
- **Lower Haight Local overlaps the venue feeds** (re-lists Faight Open Mics, Madrone Game
  Night) — deduping is required, not optional. It re-titles as it goes, sometimes past all
  resemblance ("Prince vs Michael at Madrone" for Madrone's own "Pop Life"), so matching on
  title alone isn't enough: same day + same venue + same start time, across two sources, is
  the rule that catches those.
- **The venue's own listing wins a merge.** An aggregator's title, time and link are all
  second-hand; `AGGREGATORS` in `scrape.mjs` says which sources those are.
- **Prefer a venue's own feed over an aggregator.** DoTheBay listed 3 upcoming Madrone events;
  Madrone's own iCal export listed 68. Aggregators only carry what someone cross-posted.
- **The Events Calendar (WordPress) exports one view at a time** — `?ical=1` on a month view
  covers that month, so a multi-week window means one fetch per month it touches.
- **Madrone is behind a bot check** that serves an HTML holding page instead of the feed for
  roughly 1 request in 3, at random. Retrying clears it; `fetchIcs()` does.
- **Civic Joy Fund's events page holds no event data** — it renders an Elfsight widget, and the
  real feed is the public Google Calendar named in that widget's config. Two traps: the widget's
  own `settings.events` array is Elfsight demo data (a Los Angeles museum, lorem ipsum), and the
  link people actually want is inside each entry's description, not `htmlLink`.
- **tiat's Luma calendar aggregates other calendars' events** and `get-items` returns no
  descriptions; its `calendar_api_id` (`cal-twiOosdGMMY66DI`) is one of several on the page — the
  others aren't tiat. Fixed the missing-description gap for tiat specifically: `fetchLuma()` makes
  one extra `event/get` call per event when the calendar config sets `fetchDescriptions: true`,
  flattening the rich-text `description_mirror` doc tree it returns into plain text. Only ~4
  upcoming events, so one extra request each is nothing.
- **The Commons' Luma calendar (`cal-ahTi4ptrN9WCYkg`) doesn't aggregate** — every entry is owned
  by its own calendar, unlike tiat's. Still no descriptions from `get-items`, and — unlike tiat —
  `fetchDescriptions` isn't turned on here: ~85 events/run makes the per-event fetch a much
  heavier cost, for a calendar whose Community & Social fallback already lands right most of the
  time. It's the source where enrichment would help the most, though — cryptic titles like
  "LongeviTEA: A Tech Week Reset" give the keyword matcher nothing — so revisit if the per-run
  request budget allows it.
- **Civic Joy Fund's calendar description is never real copy** — always a signup CTA ("Sign up
  here: <link>"), not descriptive text, so `categorize()` had nothing there to read. Its titles
  are formulaic enough that this barely matters (85 of 106 are "<Neighborhood> Clean Up",
  unambiguous alone). `enrichDescriptions: true` on this calendar tries anyway: fetch each event's
  own page, pull a description from its schema.org JSON-LD or `og:description`, re-categorize
  against it, and fail silently back to the boilerplate on any error. It skips mobilize.us and
  Google-redirect hosts outright (86 of 106 events — mobilize.us is a signup form, not a
  description, so scraping it wouldn't help even if it weren't likely to block a bot), landing on
  the ~15-20 events that link to Eventbrite or a neighborhood site instead — night markets,
  festivals, walks. That's also where it earns its keep: e.g. "Scaling the Heights: Telegraph Hill
  to Russian Hill" only gets tagged Fitness & Wellness once the scraped copy mentions "walk,"
  since the title alone doesn't say so.
- **The category taxonomy got a rework once Civic Joy Fund (106 events) and the fuller Commons
  calendar landed.** "Nightlife" is gone — 30 of its 36 events already carried Music too (a DJ
  set is still music), so it wasn't distinguishing anything, just double-tagging; its keywords
  (dj, disco, dance party, rave...) now feed Music directly. "Community & Social" was over 60% of
  all events and meant nothing as a filter, so it split into four: Community & Social (casual
  hangouts — coffee hours, trivia, bingo), Volunteering & Civic (cleanups, almost entirely Civic
  Joy Fund), Festivals & Markets (night markets, street fairs, renamed/broadened from "Cultural"),
  and Talks & Workshops (panels, coaching, salons — mostly The Commons). Also fixed a
  pre-existing regex bug while in there: `\b(...|line danc)\b` never matched "Line Dancing"
  because the trailing `\b` requires a word boundary right after "danc" — but "danc" is followed
  by "ing", not a boundary, so it silently never fired. Fragments kept as prefixes now use
  `\w*` (`line danc\w*`) instead of relying on a boundary that isn't there.
- **One date control, not two.** The page defaults to every upcoming event; date is filtered by
  a single strip of the next 7 days (today first) plus a "Pick date" button that opens the
  native date picker for anything further out. The old rolling-window ("next 7/14 days") and
  per-month chips were dropped — with ~160 events over two months the whole list scrolls fine,
  and a second date widget only competed with the day strip. Category now sits beside the date
  strip at the top level; only source hides under "More filters".
- **The list groups by day under a month rule**, and each event row leads with its start time
  rather than repeating the date — the day header carries that. Day headers count only the
  events passing the current filters, and stick below the filter header while you scroll; the
  header's height is measured into `--head-h` by a ResizeObserver, because it changes with the
  viewport and when "More filters" opens.
- **Below 640px the category chips fold into "More filters"** with source, to keep the sticky
  header from eating the screen (233px collapsed on a phone, vs 340-odd with them showing).
  The count badge on that toggle therefore depends on the viewport, via `matchMedia`.
- `npm run serve` (or any static server) to preview: `file://` breaks the `fetch` of
  `events.json`.
- Categorization for calendar sources is keyword-based (`categorize()` in `scrape.mjs`) — tune
  the regexes as coverage grows.

## Next steps / backlog

- Get a Google API key and run the full 5-source pull.
- Schedule the scraper (cron / task) to refresh `events.json` daily.
- Wire the PoC page to read live `events.json` instead of inlined data.
- Broaden beyond Lower Haight: add Ticketmaster Discovery, Funcheap RSS, Rec & Park RSS,
  Meetup, and evaluate Decentered Arts (events.decentered.org).
- Enrich tiat events with descriptions — Luma's `get-items` doesn't return them, so it'd take a
  per-event `event/get` fetch.
- Consider a proper start-timestamp per event (don't rely on parsing display strings).
