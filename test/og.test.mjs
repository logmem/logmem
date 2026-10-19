import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

const page = (p) => readFileSync(new URL(`../public/${p}`, import.meta.url), "utf8");
const meta = (html, attr, key) => new RegExp(`<meta ${attr}="${key.replace(/[:]/g, "\\:")}" content="([^"]+)">`).exec(html)?.[1];

test("og: the card image exists, is a PNG and is small enough to share", () => {
  const buf = readFileSync(new URL("../public/og/logmem-og.png", import.meta.url));
  assert.equal(buf.subarray(1, 4).toString(), "PNG");
  assert.equal(buf.readUInt32BE(16), 1200);
  assert.equal(buf.readUInt32BE(20), 630);
  assert.ok(statSync(new URL("../public/og/logmem-og.png", import.meta.url)).size < 300_000);
});

for (const [file, path] of [["index.html", "/"], ["onboarding.html", "/onboarding"]]) {
  test(`og: ${file} has Open Graph and Twitter tags with an absolute image URL`, () => {
    const html = page(file);
    assert.equal(meta(html, "property", "og:image"), "https://logmem.si/og/logmem-og.png");
    assert.equal(meta(html, "property", "og:image:width"), "1200");
    assert.equal(meta(html, "property", "og:image:height"), "630");
    assert.ok(meta(html, "property", "og:image:alt"));
    assert.equal(meta(html, "property", "og:url"), `https://logmem.si${path}`);
    assert.equal(meta(html, "property", "og:type"), "website");
    assert.equal(meta(html, "property", "og:site_name"), "LogMem");
    assert.ok(meta(html, "property", "og:title"));
    assert.ok(meta(html, "property", "og:description"));
    assert.equal(meta(html, "name", "twitter:card"), "summary_large_image");
    assert.equal(meta(html, "name", "twitter:image"), "https://logmem.si/og/logmem-og.png");
    assert.match(html, new RegExp(`<link rel="canonical" href="https://logmem.si${path}">`));
    assert.match(html, /<script defer src="\/_vercel\/insights\/script\.js"><\/script>/);
    assert.ok(!/ACMI/.test(meta(html, "property", "og:title") + meta(html, "property", "og:description")));
    const ldMatch = /<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/.exec(html);
    assert.ok(ldMatch, `${file} has application/ld+json structured data`);
    const ld = JSON.parse(ldMatch[1]);
    assert.equal(ld["@context"], "https://schema.org");
    assert.ok(!/ACMI/.test(ldMatch[1]), `${file} JSON-LD does not name ACMI`);
    assert.doesNotMatch(ldMatch[1], /\$\d/, `${file} JSON-LD has no prices`);
  });
}

test("seo: robots.txt and sitemap.xml cover public routes and exclude internal pages", () => {
  const robots = page("robots.txt");
  assert.match(robots, /^User-agent: \*/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.match(robots, /^Disallow: \/app$/m);
  assert.match(robots, /^Disallow: \/scorecard$/m);
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.match(robots, /^Sitemap: https:\/\/logmem\.si\/sitemap\.xml$/m);

  const sitemap = page("sitemap.xml");
  assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(sitemap, /<loc>https:\/\/logmem\.si\/<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/logmem\.si\/onboarding<\/loc>/);
  assert.doesNotMatch(sitemap, /\/app\b|\/scorecard\b|\/api\b/);

  for (const internal of ["app.html", "scorecard.html"]) {
    assert.match(page(internal), /<meta name="robots" content="noindex">/);
  }
});
