# SF Events Scraper

Aggregates upcoming San Francisco neighborhood events from seven sources into a single
normalized, de-duplicated, category-tagged feed (`events.json`).

Built for the "SF events" project — pulls the coming weeks of events so they can be
filtered by category (music, arts, fitness, cultural, community, nightlife).

## Sources

| Source | Route | Notes |
|---|---|---|
| **The Faight** | Sanity CMS API | Project `3l1powkg`, dataset `production`. Filters `status=="published"` and `!isPrivate`. |
| **Madrone Art Bar** | DoTheBay JSON feed | `https://dothebay.com/venues/madrone-art-bar.json`. Add more venues in `DOTHEBAY_VENUES`. |
| **Wave Collective** | Google Calendar API | Public calendar. Heavy on private bookings — filtered out. |
| **Lower Haight Local** | Google Calendar API | Neighborhood calendar spanning many venues. Overlaps other sources (deduped). |
| **Gather SF** | Google Calendar API | Pop-up teahouse nonprofit; currently sparse. |
| **Gather SF (page)** | <https://www.gathersf.org/events> | Framer page with no event data of its own — followed out to the Luma / Partiful / Eventbrite pages it links, which publish schema.org `Event` JSON-LD. No key needed. Often stale (past events), which the global past filter drops. |
| **tiat** | Luma JSON feed | Art/tech gallery at 151 Powell St. Calendar `cal-twiOosdGMMY66DI`. No descriptions in the feed; virtual events filtered out. |

## Requirements

- Node 18+ (uses built-in `fetch`, no dependencies).

## Run

```bash
node scrape.mjs
```

Without any setup, this pulls **The Faight**, **Madrone**, **tiat** and **Gather SF's events
page** (no key needed) and writes `events.json`.

To include the three Google Calendars, set a Google API key:

```bash
GOOGLE_API_KEY=your_key_here node scrape.mjs
```

### Getting a Google API key (2 minutes, free)

1. Go to <https://console.cloud.google.com/> → create/select a project.
2. **APIs & Services → Library →** enable **Google Calendar API**.
3. **APIs & Services → Credentials → Create credentials → API key.**
4. (Recommended) Restrict the key to the Calendar API.

The calendars are public, so no OAuth is needed — just the key. (Prefer not to use a key?
Each calendar also has a public `.ics` feed you could parse instead, but the Calendar API is
used here because it expands recurring events server-side, which these calendars rely on.)

## Output

`events.json` — an array of normalized events, sorted by date then start time:

```json
{
  "source": "The Faight",
  "venue": "The Faight",
  "title": "Boy Apocalypse",
  "description": "Boy Apocalypse album release, with sets from ...",
  "date": "2026-09-24",
  "startMinutes": 1140,
  "timeLabel": "7 PM",
  "url": "https://www.eventbrite.com/e/boy-apocalypse-tickets-...",
  "free": false,
  "categories": ["Music"],
  "alsoIn": ["The Faight"]
}
```

`alsoIn` lists every source an event was found in (length > 1 means it was de-duplicated
across sources — e.g. an Open Mic listed by both The Faight and Lower Haight Local).

## Normalization rules (applied to every source)

- **Drop private events** — anything whose title matches `/private|buyout|closed/i`, plus
  The Faight's `isPrivate` flag.
- **Drop past events** — keeps today (America/Los_Angeles) forward.
- **Times → America/Los_Angeles** — sources return UTC / mixed offsets; all converted.
- **Categorize** — DoTheBay's own category maps to our vocabulary; other sources use a
  keyword classifier (`categorize()`). Tune the regexes there as needed.
- **Dedupe** — on `date + venue + normalized title`.

## Categories

`Music`, `Arts & Performance`, `Nightlife`, `Community & Social`, `Fitness & Dance`, `Cultural`.
An event can carry more than one.

## Adding a source

- **On DoTheBay/Do415?** Add its slug to `DOTHEBAY_VENUES` — the JSON feed does the rest.
- **Has a public Google Calendar?** Add `{ source, venue, id }` to `GCALS` (find the calendar
  ID in the "add to Google Calendar" link — decode the `cid=` base64 or read the `src=`).
- **Hosts on Luma?** Add `{ source, venue, id, fallback }` to `LUMA_CALENDARS`. `id` is the
  `calendar_api_id` (`cal-…`) in the calendar page's embedded JSON, not the vanity slug — a page
  can embed several, so confirm which one returns the venue's own events.
- **Has a headless CMS or its own API?** Add a `fetchX()` that returns the normalized shape.

## Web UI

`index.html` is a filterable events page (date / category / source) that fetches `events.json`
from the same directory. Open it locally with any static file server, e.g.:

```bash
npx serve .
```

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` runs the scraper daily (and on every push / manual dispatch),
commits any changes to `events.json`, then publishes `index.html` + `events.json` to GitHub
Pages via `actions/deploy-pages`.

One-time setup (repo settings can't be changed from a workflow file):

1. On GitHub: **Settings → Pages → Build and deployment → Source → GitHub Actions**.
2. (Optional) Add a `GOOGLE_API_KEY` repository secret (**Settings → Secrets and variables →
   Actions**) to also pull Wave Collective, Lower Haight Local, and Gather SF. Without it, the
   deployed site still gets The Faight + Madrone.
3. Push to this branch (or run the workflow manually from the **Actions** tab) to trigger the
   first deploy. The site URL appears on the workflow run and under **Settings → Pages**.
