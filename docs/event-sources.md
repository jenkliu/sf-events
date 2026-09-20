# SF Event Sources — catalog for the weekly aggregator

Goal: pull the coming week's SF events into one place, filterable by category (music, arts, fitness, cultural, etc.). This lists sources ranked by how easily an automated task can ingest them, plus which categories each covers. Last reviewed: 2026-09-20.

## The honest architecture

There is no single API that returns "all SF events." A good aggregator blends a few structured feeds/APIs (the reliable backbone) with light scraping of a few well-structured sites (for the long tail), then normalizes, filters, dedupes and tags by category. Two things to know up front:

- Eventbrite's public event-search API was shut off in Feb 2020. You can only pull events for your own organization now, not search all public events. To get Eventbrite listings you either scrape or use a third-party scraper. Don't design around an Eventbrite "search everything" call — it no longer exists.
- Meetup's API is GraphQL and needs OAuth (and a Pro subscription for the fullest access), but it's the best structured source for fitness/social/hobby events.

## Global normalization rules (apply to every source)

- **Drop private events.** Venue calendars are full of private buyouts/holds. Exclude anything marked private: The Faight's Sanity `isPrivate == true`; Google Calendar entries titled "Private Event" (or "Private", "Buyout", "Closed"). Wave Collective's calendar alone had 9 private holds in ~6 weeks. Match on the private flag where available, and on a title regex `/(^|\b)(private|buyout|closed)\b/i` otherwise.
- **Drop past events.** Only keep events from now forward (some sources, e.g. Gather SF, leave stale past events on the page).
- **Convert times to America/Los_Angeles.** Google Calendar and Sanity return UTC.
- **Normalize to one shape:** title, start (date+time), end, venue, category[], url, price/free, source. Keep a parseable start time for sorting (sort within a day earliest→latest).
- **Dedupe on date + venue + normalized title** — sources overlap (see Lower Haight Local below).

## Tracked venues & neighborhood sources (what Jen wants monitored)

Specific venues and neighborhood feeds to pull directly, separate from the broad aggregators below. All confirmed working as of 2026-09-20 (pulled live).

- **The Faight** — 475 Haight St, Lower Haight. Page: https://www.thefaight.com/events — A Next.js site backed by a **public Sanity CMS**, which is the real prize: query it directly instead of scraping HTML. Project `3l1powkg`, dataset `production`. Endpoint: `https://3l1powkg.apicdn.sanity.io/v2021-10-21/data/query/production?query=<GROQ>`. Working query: `*[_type=="event" && status=="published" && !isPrivate && startTime > "<now>"]|order(startTime asc){title, startTime, endTime, ctaUrl, "desc":pt::text(description), "slug":slug.current}`. Notes: filter `status=="published"` and `!isPrivate`; `ctaUrl` is the ticket link (usually Eventbrite); `startTime` is UTC. **Do not** pull the `showNotes` field — internal production notes with artist contact info. Cross-origin browser fetch is CORS-blocked; fetch server-side. Category profile: almost entirely Music, plus recurring Open Mics (Community) and the occasional electronic/Nightlife night.
- **Madrone Art Bar** — 500 Divisadero St, NoPa. Pulled via its DoTheBay JSON feed: `https://dothebay.com/venues/madrone-art-bar.json` (events under `event_groups[].events[]`, with `title`, `description`, `tz_adjusted_begin_date`, `category_param`, `is_free`, `past`, `permalink`). No HTML scraping needed. Category profile: genuinely mixed (Arts & Performance, Community & Social, Nightlife, Cultural). Mostly free.
- **Wave Collective** — 663 Haight St, Lower Haight. A café/event space with a **public Google Calendar**: ID `k5bmnva5i30lo1id9kovrvjc4g@group.calendar.google.com` (name: "Wave Collective Space Events Calendar"). Ingest via **Google Calendar API v3** `events.list` with `singleEvents=true` (free API key). IMPORTANT: heavy on private bookings titled "Private Event" — filter them out (see global rules). Public events are recurring café/community programming (Coffee Hours, Coffee & Wine Hours, DJ and Wine Fridays, Poetry Circle) plus one-offs (comedy nights, art openings). Category profile: Community, Nightlife/Music, Arts.
- **Lower Haight Local** — https://www.lowerhaightlocal.com/events — a volunteer neighborhood calendar (501c3, est. 2025) spanning many Lower Haight venues at once: Madrone, Woods Lowside, Danny Coyle's, Mercury Cafe, The Booksmith, Underground SF, The Faight, plus street fairs, park movie nights, and weekly cleanups. Best category coverage of anything on this list — the only source that reliably surfaces Fitness (line dancing), Community (cleanups, trivia, bingo), and Cultural (street fairs). Public Google Calendar ID `c355b17347d2721bff62a21b8378d5caa0a717f34a4a465f13a624d85525e6d6@group.calendar.google.com` (or scrape the HTML page). NOTE: this is a DIFFERENT calendar from Wave Collective's. Overlap warning: this feed re-lists events already coming from The Faight (Open Mics) and Madrone (Game Night), so it's the clearest real dedup case in the set.
- **Gather SF** — https://www.gathersf.org/events — a 501(c)3 teahouse/community nonprofit (tea, movement, mindful connection). Framer site; individual events are hosted on Luma. Currently "between homes" and running only occasional pop-ups, so the page is often sparse or shows stale past events (drop past events per global rules). Public Google Calendar ID `0cb73e0cfb94515e2121d1abb6489a84e79133780b7d7c1a5ebba0668340f9a9@group.calendar.google.com`. **Also ingested keylessly from the page itself** (`fetchGatherSF()`): Framer renders the listing into HTML, and each event links out to Luma/Partiful/Eventbrite, all of which publish schema.org `Event` JSON-LD (`name`, `startDate`, `location`, `offers.price`) — so read any JSON-LD on the page, then follow the ticket links and read theirs; `__NEXT_DATA__` (`name` + `start_at`) is the fallback for Next.js pages that omit it. Both routes carry the source name `Gather SF`, so the calendar and the page dedupe against each other. Category profile: Cultural, Community, Fitness (movement/qi gong). BONUS lead: the page also points to **Decentered Arts** (https://events.decentered.org) — a broad Bay Area art/community events list worth evaluating as its own source.

Pattern to reuse: many independent venues run on a headless CMS (Sanity, Contentful), host events on Luma/Eventbrite, or expose a public Google Calendar — check for a JSON/API/calendar source before writing an HTML scraper (look at network requests or asset URLs for a project ID or calendar ID). For venues on DoTheBay/Do415, use the venue JSON feed (`/venues/<slug>.json`) — one parser covers all of them. Hand-scrape HTML only as a last resort. To add a venue: (1) check `dothebay.com/venues/<slug>`; (2) check the venue's own site for a CMS/API/Google Calendar/Luma; (3) fall back to HTML scraping.

## Tier 1 — structured feeds and APIs (build on these first)

- **Ticketmaster Discovery API** — free, ~5,000 calls/day. Search by geo/DMA (covers SF Bay Area) and by classification (Music, Arts & Theatre, Sports, Film, Miscellaneous). Backbone for ticketed music, theater, and sports, already categorized. https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/
- **SF Funcheap — RSS feed** — free/cheap events across every category, updated daily. https://sf.funcheap.com/rss-date/
- **SF Rec & Park — RSS + calendar** — city recreation, fitness, outdoor, community events. https://sfrecpark.org/rss.aspx
- **Songkick API** — concerts by metro area (SF Bay Area). Needs an API key. https://www.songkick.com/metro-areas/26330-us-sf-bay-area
- **Bandsintown API** — concert/tour data by artist and city.
- **Meetup (GraphQL API)** — fitness, running/cycling clubs, tech, social, hobby groups. Needs OAuth.
- **DataSF / SFGov** — city open-data and official civic events; permitted street events/festivals. https://sfgov.org/

## Tier 2 — scrape-friendly, well-structured sites (fill the gaps)

- **DoTheBay / Do415** — strong, category-tagged listings; `/venues/<slug>.json` and other JSON feeds are clean. https://dothebay.com/
- **19hz.info (Bay Area)** — the definitive list for electronic/dance/DJ events. Tabular and easy to parse.
- **Decentered Arts** — https://events.decentered.org — a large Bay Area art/community events list (surfaced via Gather SF). Evaluate for coverage and structure.
- **SF Station** — general calendar with category sub-calendars. https://www.sfstation.com/calendar
- **SF/Arts (sfarts.org)** — dedicated arts & culture calendar. https://www.sfarts.org/calendar/
- **AllEvents.in** — aggregates many sources. https://allevents.in/san-francisco/calendar
- **Eventbrite (scrape or org-only API)** — workshops, fitness classes, cultural/community events. Public search API is gone. https://www.eventbrite.com/d/ca--san-francisco/events/

## Tier 3 — editorial / curation (great for enrichment, harder to fully automate)

- **7x7** — arts & culture roundups. https://www.7x7.com/
- **Time Out San Francisco** — things-to-do editorial.
- **The Bold Italic** — local culture and events roundups.
- **48 Hills** and **Broke-Ass Stuart** — alt/underground culture and free events.
- **SF Chronicle Datebook** — arts and entertainment editorial calendar.

## Category → best sources

- **Music (ticketed):** Ticketmaster Discovery, Songkick, Bandsintown. **Nightlife/electronic:** 19hz.info, DoTheBay. **Free/small:** Funcheap, Sofar Sounds.
- **Arts / theater / museums:** Ticketmaster (Arts & Theatre), SF/Arts, venue sites (SFMOMA, de Young, Exploratorium After Dark, Cal Academy NightLife, SF Symphony/Opera/Ballet), 7x7.
- **Cultural / festivals:** Funcheap, DoTheBay, DataSF, Lower Haight Local, Gather SF, SF Travel, neighborhood/cultural-district calendars.
- **Fitness / wellness / outdoors:** Meetup, SF Rec & Park, Lower Haight Local (line dancing), Gather SF (movement/qi gong), Eventbrite (fitness classes), Strava clubs, November Project SF.
- **Free / community / civic:** Lower Haight Local, Wave Collective, Gather SF, Funcheap, Broke-Ass Stuart, 48 Hills, Rec & Park, SF Public Library events.

## Recommended v1 build

Start with the pieces that need the least glue: **Ticketmaster Discovery API + Funcheap RSS + Rec & Park RSS + Meetup API + the tracked venues** (Faight CMS, Madrone via DoTheBay, Wave Collective + Lower Haight Local + Gather SF via Google Calendar API), then add scrapers for **DoTheBay** and **19hz.info** once the pipeline works. Apply the global normalization rules — especially dropping private and past events, sorting within each day by start time, and deduping across sources.
