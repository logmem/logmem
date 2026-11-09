import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

const origin = "https://logmem.si";
const read = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url), "utf8");

// Static checks deliberately cover the existing HTML site without requiring a
// framework or network. Deployment redirects and crawler behavior need separate
// runtime verification; passing these checks does not establish search ranking.
const attribute = (tag, name) => new RegExp(`\\b${name}=["']([^"']*)["']`, "i").exec(tag)?.[1];
const tags = (html, name) => html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) || [];
const metadata = (html, key) => tags(html, "meta")
  .filter((tag) => attribute(tag, "name") === key || attribute(tag, "property") === key)
  .map((tag) => attribute(tag, "content"));

const locations = [...read("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);

test("search: the public sitemap has unique, same-origin clean URLs", () => {
  assert.ok(locations.length > 0);
  assert.equal(new Set(locations).size, locations.length);
  for (const location of locations) {
    const url = new URL(location);
    assert.equal(url.origin, origin, location);
    assert.equal(url.search, "", location);
    assert.equal(url.hash, "", location);
    assert.doesNotMatch(url.pathname, /\.html$/, location);
    assert.doesNotMatch(url.pathname, /^\/(?:app|api|keys|connections|scorecard|sign-in)(?:\/|$)/, location);
  }
});

for (const location of locations) {
  test(`search: ${new URL(location).pathname} has indexable canonical HTML and descriptive metadata`, () => {
    const url = new URL(location);
    const file = url.pathname === "/" ? "index.html" : `${url.pathname.slice(1)}.html`;
    const html = read(file);
    const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1];
    assert.ok(head, file);
    const titles = [...head.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)];
    assert.equal(titles.length, 1, `${file}: one title`);
    assert.ok(titles[0][1].trim(), `${file}: non-empty title`);
    const descriptions = metadata(head, "description");
    assert.equal(descriptions.length, 1, `${file}: one description`);
    assert.ok(descriptions[0]?.trim(), `${file}: non-empty description`);
    const canonicals = tags(head, "link").filter((tag) =>
      (attribute(tag, "rel") || "").toLowerCase().split(/\s+/).includes("canonical"));
    assert.equal(canonicals.length, 1, `${file}: one canonical`);
    assert.equal(attribute(canonicals[0], "href"), location, file);
    for (const key of ["robots", "googlebot"]) {
      for (const directive of metadata(head, key)) {
        assert.doesNotMatch(directive || "", /\b(?:noindex|none)\b/i, `${file}: listed public page must be indexable`);
      }
    }
  });
}

test("search: documentation sharing metadata matches its visible title and description", () => {
  const html = read("docs.html");
  const title = /<title>([^<]+)<\/title>/.exec(html)[1];
  const description = metadata(html, "description")[0];
  assert.deepEqual(metadata(html, "og:url"), [`${origin}/docs`]);
  assert.deepEqual(metadata(html, "og:type"), ["website"]);
  assert.deepEqual(metadata(html, "og:site_name"), ["LogMem"]);
  for (const prefix of ["og", "twitter"]) {
    assert.deepEqual(metadata(html, `${prefix}:title`), [title]);
    assert.deepEqual(metadata(html, `${prefix}:description`), [description]);
    const images = metadata(html, `${prefix}:image`);
    assert.deepEqual(images, [`${origin}/og/logmem-og.png`]);
    assert.ok(statSync(new URL(`../public${new URL(images[0]).pathname}`, import.meta.url)).isFile());
    assert.ok(metadata(html, `${prefix}:image:alt`)[0]?.trim());
  }
  assert.deepEqual(metadata(html, "og:image:width"), ["1200"]);
  assert.deepEqual(metadata(html, "og:image:height"), ["630"]);
  assert.deepEqual(metadata(html, "twitter:card"), ["summary_large_image"]);
});
