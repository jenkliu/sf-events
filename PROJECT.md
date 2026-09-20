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
  the regexes as coverage grows.

## Next steps / backlog

- Get a Google API key and run the full 5-source pull.
- Schedule the scraper (cron / task) to refresh `events.json` daily.
- Wire the PoC page to read live `events.json` instead of inlined data.
- Broaden beyond Lower Haight: add Ticketmaster Discovery, Funcheap RSS, Rec & Park RSS,
  Meetup, and evaluate Decentered Arts (events.decentered.org).
- Add **tiat** (151 Powell St, art/tech gallery, https://www.tiat.place/events) as a source.
  Events live on Luma (https://luma.com/tiat) — need the calendar's `calendar_api_id` from an
  unrestricted network to wire up `fetchLuma()`; see `docs/event-sources.md` for details.
- Consider a proper start-timestamp per event (don't rely on parsing display strings).
