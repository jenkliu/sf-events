# SF Events — project overview

Aggregate the events happening in SF in the upcoming week into one place, filterable by
category (music, arts, fitness, cultural, community, nightlife). Starting as a personal
automated task; may grow into an app with a UI.

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
| Madrone Art Bar | DoTheBay `/venues/<slug>.json` | none |
| Gather SF | gathersf.org/events page + its Luma/Partiful/Eventbrite links | none |
| Wave Collective | Google Calendar API | needs `GOOGLE_API_KEY` |
| Lower Haight Local | Google Calendar API | needs `GOOGLE_API_KEY` |
| Gather SF | Google Calendar API | needs `GOOGLE_API_KEY` |

## Normalized event shape

`{ source, venue, title, description, date, startMinutes, timeLabel, url, free, categories[], alsoIn[] }`
— sorted by date then start time. `alsoIn.length > 1` means it was de-duplicated across sources.

## Decisions / gotchas worth remembering

- **No single "all SF events" API.** Blend structured feeds + light scraping, then dedupe.
- **Eventbrite public search API is dead** (since 2020) — scrape or use its per-org API only.
- **Drop private + past events** globally. Wave Collective's calendar is mostly private holds.
- **The Faight `showNotes` field is internal** (artist contact info) — never surface it.
- **Google Calendars: use the API with `singleEvents=true`** so recurring events expand.
- **Lower Haight Local overlaps the venue feeds** (re-lists Faight Open Mics, Madrone Game
  Night) — deduping is required, not optional.
- Categorization for calendar sources is keyword-based (`categorize()` in `scrape.mjs`) — tune
  the regexes as coverage grows. Gather SF's wellness/ceremony vocabulary (cacao, sound bath,
  ecstatic dance, solstice, meditation) is folded in.
- **Ticket hosts publish schema.org JSON-LD.** Luma, Partiful, and Eventbrite event pages all
  carry an `Event` block, so a listing page that links out to them can be ingested without a
  per-site HTML parser — read the JSON-LD on the page, then follow the links and read theirs
  (`fetchGatherSF()`). `__NEXT_DATA__` is the fallback for Next.js pages that omit JSON-LD.
- **Gather SF now has two routes** (page + Google Calendar). Both use the source name
  `Gather SF`, so dedupe merges them; the page route is the one that works with no API key.
- **Sources are fetched in parallel, so every promise needs its handler attached up front**
  (`settle()` in `scrape.mjs`) — otherwise one source failing fast kills the whole run.
- `scrape.mjs` only runs `main()` when invoked directly, so `npm test` can import its parsers.

## Next steps / backlog

- Get a Google API key and run the full 6-source pull.
- Schedule the scraper (cron / task) to refresh `events.json` daily.
- Wire the PoC page to read live `events.json` instead of inlined data.
- Broaden beyond Lower Haight: add Ticketmaster Discovery, Funcheap RSS, Rec & Park RSS,
  Meetup, and evaluate Decentered Arts (events.decentered.org).
- Consider a proper start-timestamp per event (don't rely on parsing display strings).
