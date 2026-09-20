// End-to-end test of the Gather SF source against a local fixture server.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

const page = `<!doctype html><html><head>
  <script type="application/ld+json">
  [
    {"@context":"https://schema.org","@type":"Organization","name":"Gather Collective"},
    {"@context":"https://schema.org","@type":"SocialEvent",
     "name":"Pop-up Tea Lounge","description":"Tea flowing freely from the center of the space.",
     "startDate":"2099-10-04T18:30:00-07:00","url":"https://lu.ma/tea-lounge",
     "location":{"@type":"Place","name":"Gather SF"},
     "offers":[{"@type":"Offer","price":"0"}]},
    {"@context":"https://schema.org","@type":"Event",
     "name":"Qi Gong in the Park","startDate":"2099-10-05T10:00:00-07:00",
     "location":{"@type":"Place","name":"Duboce Park, San Francisco"},
     "offers":[{"@type":"Offer","price":"20"}]},
    {"@context":"https://schema.org","@type":"Event",
     "name":"Pop-up Tea Lounge","startDate":"2099-10-04T18:30:00-07:00"}
  ]
  </script>
</head><body><a href="/about">About</a></body></html>`;

async function withServer(html, fn) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/events`;
  try {
    return await fn(url);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("fetchGatherSF normalizes a live page into feed rows", async () => {
  const events = await withServer(page, async (url) => {
    process.env.GATHER_SF_URL = url;
    const { fetchGatherSF } = await import("../scrape.mjs");
    return fetchGatherSF();
  });

  // The repeated "Pop-up Tea Lounge" node collapses into one row.
  assert.equal(events.length, 2);

  assert.deepEqual(events[0], {
    source: "Gather SF",
    venue: "Gather SF",
    title: "Pop-up Tea Lounge",
    description: "Tea flowing freely from the center of the space.",
    date: "2099-10-04",
    startMinutes: 18 * 60 + 30,
    timeLabel: "6:30 PM",
    url: "https://lu.ma/tea-lounge",
    free: true,
    categories: ["Community & Social"],
  });

  const qigong = events[1];
  assert.equal(qigong.venue, "Duboce Park"); // a named place beats the default
  assert.equal(qigong.free, false);
  assert.deepEqual(qigong.categories, ["Fitness & Dance"]);
  assert.equal(qigong.url, `${process.env.GATHER_SF_URL}`); // falls back to the page
});

test("mapPool runs with bounded concurrency and keeps input order", async () => {
  const { mapPool } = await import("../scrape.mjs");
  let inFlight = 0, peak = 0;
  const out = await mapPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded the limit`);
});
