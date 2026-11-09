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

test("search: sitemap pages have distinct descriptions", () => {
  const seen = new Map();
  for (const location of locations) {
    const path = new URL(location).pathname;
    const html = read(path === "/" ? "index.html" : `${path.slice(1)}.html`);
    const description = metadata(html, "description")[0].trim().toLowerCase().replace(/\s+/g, " ");
    assert.ok(!seen.has(description), `${location} duplicates ${seen.get(description)}`);
    seen.set(description, location);
  }
});

test("search: onboarding has one persistent H1 and focusable H2 step headings", () => {
  const html = read("onboarding.html");
  assert.equal((html.match(/<h1\b/gi) || []).length, 1);
  assert.match(html, /<h1 class="lm-sr">Set up LogMem<\/h1>/);
  const steps = [...html.matchAll(/<section\b[^>]*data-step="([^"]+)"[^>]*>/g)].map(match => match[1]);
  assert.equal(steps.length, 11);
  for (const step of steps) {
    assert.ok(html.includes(`<h2 class="ob-step-title" id="h-${step}" tabindex="-1">`), step);
  }
  assert.match(read("onboarding.css"), /\.ob-card \.ob-step-title\[tabindex="-1"\]:focus-visible/);
  assert.match(read("onboarding.js"), /h\.focus\(\{ preventScroll: true \}\)/);
  assert.ok(html.includes('<link rel="canonical" href="https://logmem.si/onboarding">'));
});

test("search: pricing headings never skip a level and mobile plan styles follow H2", () => {
  const html = read("pricing.html");
  let previous = 0;
  for (const match of html.matchAll(/<h([1-6])\b/gi)) {
    const level = Number(match[1]);
    assert.ok(level <= previous + 1, `heading jumped from H${previous} to H${level}`);
    previous = level;
  }
  assert.equal((html.match(/<article class="plan-card"><h2>/g) || []).length, 7);
  assert.match(read("pages.css"), /\.plan-card h2\s*\{/);
});

test("search: setup indexes explain paths and skill purposes in static HTML", () => {
  const agents = read("agents.html"), skills = read("skills.html");
  for (const phrase of ["Hosted MCP:", "Local MCP:", "Agent key:", "does not start an autonomous worker"]) {
    assert.ok(agents.includes(phrase), phrase);
  }
  for (const phrase of ["Everyday LogMem:", "Agent onboarding:", "Decisions:", "Read-path recovery:", "SDK primitives:", "Seed a space:", "Self-hosting:", "Tracking and outages:"]) {
    assert.ok(skills.includes(phrase), phrase);
  }
  for (const html of [agents, skills]) {
    assert.match(html, /<section class="agent-step step-card" aria-labelledby=/);
  }
});

test("search: docs title is concise and terms metadata remains consistent", () => {
  const docs = read("docs.html"), terms = read("terms.html");
  assert.equal(/<title>([^<]+)<\/title>/.exec(docs)[1], "LogMem Docs — Architecture, Tools & Setup");
  const description = metadata(terms, "description")[0];
  assert.ok(description.length >= 70 && description.length <= 160);
  assert.deepEqual(metadata(terms, "og:description"), [description]);
});
