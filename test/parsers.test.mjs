// Parser tests for the Gather SF source — no network, fixtures only.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";

import { extractJsonLd, isLdEvent, eventFromLd, eventsFromNextData, harvestEventLinks } from "../scrape.mjs";

const ldEvents = (html) => extractJsonLd(html).filter(isLdEvent);

// A Framer-rendered listing page: cards linking out to the ticket hosts.
const gatherPage = `<!doctype html><html><body>
  <a href="/">Home</a>
  <a href="https://lu.ma/mandala-night">Mandala Night</a>
  <a href="https://lu.ma/mandala-night?tk=abc#rsvp">Mandala Night (dup)</a>
  <a href="https://www.partiful.com/e/L5umuQbXs1nJ1d46AZba">Pop-up Tea Lounge</a>
  <a href="https://lu.ma/user/gathersf">Our Luma profile</a>
  <a href="https://events.decentered.org">Decentered Arts</a>
  <a href="mailto:alex@gathersf.org">Email us</a>
  <a href="https://www.eventbrite.com/e/qigong-tickets-12345">Qi Gong</a>
</body></html>`;

test("harvestEventLinks keeps ticket pages, drops profiles and non-event links", () => {
  assert.deepEqual(harvestEventLinks(gatherPage), [
    "https://lu.ma/mandala-night",
    "https://www.partiful.com/e/L5umuQbXs1nJ1d46AZba",
    "https://www.eventbrite.com/e/qigong-tickets-12345",
  ]);
});

test("harvestEventLinks resolves relative hrefs against the page", () => {
  const html = `<a href="//lu.ma/tea-lounge">Tea</a><a href="/about">About</a>`;
  assert.deepEqual(harvestEventLinks(html), ["https://lu.ma/tea-lounge"]);
});

test("extractJsonLd reads @graph and skips malformed blocks", () => {
  const html = `
    <script type="application/ld+json">{ this is not json }</script>
    <script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[
        {"@type":"Organization","name":"Gather Collective"},
        {"@type":"SocialEvent","name":"Mandala Night","startDate":"2026-10-03T19:00:00-07:00"}
      ]}
    </script>`;
  const events = ldEvents(html);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "Mandala Night");
});

test("eventFromLd normalizes a Luma event page to the feed shape", () => {
  const luma = `<script type="application/ld+json">{
    "@context":"https://schema.org","@type":"Event",
    "name":"Pop-up Tea Lounge",
    "description":"Tea flowing freely from the center of the space.",
    "startDate":"2026-10-04T18:30:00-07:00",
    "url":"https://lu.ma/tea-lounge",
    "location":{"@type":"Place","name":"The Center SF, 548 Fillmore St"},
    "offers":[{"@type":"Offer","price":"0","priceCurrency":"USD"}]
  }</script>`;
  const [e] = ldEvents(luma).map((n) => eventFromLd(n, "https://lu.ma/fallback"));
  assert.deepEqual(e, {
    title: "Pop-up Tea Lounge",
    description: "Tea flowing freely from the center of the space.",
    date: "2026-10-04",
    startMinutes: 18 * 60 + 30,
    timeLabel: "6:30 PM",
    url: "https://lu.ma/tea-lounge",
    free: true,
    place: "The Center SF",
  });
});

test("eventFromLd marks paid events and falls back to the page URL", () => {
  const node = {
    "@type": "Event", name: "Tantra Workshop", startDate: "2026-10-11T13:00:00-07:00",
    offers: { price: "45.00", priceCurrency: "USD" },
  };
  const e = eventFromLd(node, "https://lu.ma/tantra");
  assert.equal(e.free, false);
  assert.equal(e.url, "https://lu.ma/tantra");
  assert.equal(e.timeLabel, "1 PM");
});

test("eventFromLd converts UTC timestamps to America/Los_Angeles", () => {
  // 2026-10-05T02:00Z is still Oct 4, 7 PM in SF.
  const e = eventFromLd({ "@type": "Event", name: "Sound Bath", startDate: "2026-10-05T02:00:00Z" }, "");
  assert.equal(e.date, "2026-10-04");
  assert.equal(e.timeLabel, "7 PM");
});

test("eventFromLd handles all-day dates and rejects unusable nodes", () => {
  const allDay = eventFromLd({ "@type": "Event", name: "Retreat", startDate: "2026-11-01" }, "");
  assert.deepEqual(
    [allDay.date, allDay.startMinutes, allDay.timeLabel],
    ["2026-11-01", -1, "All day"],
  );
  assert.equal(eventFromLd({ "@type": "Event", name: "No date" }, ""), null);
  assert.equal(eventFromLd({ "@type": "Event", startDate: "2026-11-01" }, ""), null);
  assert.equal(eventFromLd({ "@type": "Event", name: "Bad date", startDate: "soon" }, ""), null);
});

test("eventsFromNextData recovers events from a Next.js page without JSON-LD", () => {
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { initialData: { data: {
      event: {
        name: "Mandala Night",
        start_at: "2026-10-03T19:00:00-07:00",
        description: "Cacao, meditation, and mandalas.",
        url: "https://lu.ma/mandala-night",
        geo_address_info: { city_state: "San Francisco, CA", address: "548 Fillmore St" },
      },
      // the same event echoed elsewhere in the tree must not double up
      featured: { name: "Mandala Night", start_at: "2026-10-03T19:00:00-07:00" },
    } } } },
  })}</script>`;
  const events = eventsFromNextData(html, "https://lu.ma/mandala-night");
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Mandala Night");
  assert.equal(events[0].date, "2026-10-03");
  assert.equal(events[0].timeLabel, "7 PM");
  assert.equal(events[0].place, "San Francisco");
});

test("eventsFromNextData is quiet when there is nothing to read", () => {
  assert.deepEqual(eventsFromNextData("<html></html>", ""), []);
  assert.deepEqual(eventsFromNextData(`<script id="__NEXT_DATA__">{broken</script>`, ""), []);
});
