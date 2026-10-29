import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { MENU, CTA, WIDE_AFTER } from "../public/site-nav-model.js";
import { AGENT_CLIENTS } from "../public/app/agent-clients.js";

const read = p => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const HEADER_PAGES = ["index", "docs", "scorecard", "connect", "how-to", "privacy", "pricing", "terms", "agents", "skills", "onboarding", ...Object.keys(AGENT_CLIENTS).map(id => "agents/" + id)];
const links = [...MENU.flatMap(i => [i, ...(i.sub || [])]), CTA];

function resolves(href) {
  const path = href.split("#")[0] || "/";
  if (path === "/") return existsSync(new URL("../public/index.html", import.meta.url));
  const rel = "public" + path;
  return existsSync(new URL("../" + rel, import.meta.url)) || existsSync(new URL("../" + rel + ".html", import.meta.url));
}

test("site menu: every link points at a real page, and anchors exist on the home page", () => {
  for (const l of links) {
    assert.ok(resolves(l.href), l.href);
    const hash = l.href.split("#")[1];
    if (hash) assert.match(read("public/index.html"), new RegExp(`id="${hash}"`), l.href);
  }
});

test("site menu: every agent client has a sub menu entry, and sub menus have unique labels", () => {
  const agents = MENU.find(i => i.id === "agents").sub.map(s => s.href);
  for (const id of Object.keys(AGENT_CLIENTS)) assert.ok(agents.includes("/agents/" + id), id);
  for (const item of MENU) if (item.sub) assert.equal(new Set(item.sub.map(s => s.label)).size, item.sub.length, item.id);
  assert.equal(new Set(MENU.map(i => i.id)).size, MENU.length);
  assert.ok(MENU.find(i => i.id === "agents").sub.length > WIDE_AFTER);
});

test("site menu: every header page carries the one header, the script and a valid current item", () => {
  const ids = new Set(MENU.map(i => i.id));
  for (const page of HEADER_PAGES) {
    const html = read(`public/${page}.html`);
    assert.match(html, /<header class="nav" data-site-nav data-current="[a-z]*">/, page);
    const cur = html.match(/data-current="([a-z]*)"/)[1];
    assert.ok(cur === "" || ids.has(cur), page);
    assert.ok(html.includes('<script type="module" src="/site-nav.js"></script>'), page);
    assert.ok(!html.includes("agent-nav") && !html.includes("ob-header"), page);
    for (const l of MENU) assert.ok(html.includes(`href="${l.href}"`), page + " fallback link " + l.href);
  }
});

test("site menu: agent pages use the fun layer, and no page keeps its own copy of the nav rules", () => {
  for (const id of ["agents", ...Object.keys(AGENT_CLIENTS).map(i => "agents/" + i)]) {
    const html = read(`public/${id}.html`);
    assert.ok(html.includes('href="/pages.css"') && html.includes("page-wrap"), id);
  }
  assert.match(read("public/pages.css"), /^@import url\("\/site-nav.css"\);/);
  assert.doesNotMatch(read("public/pages.css"), /\n\.nav\{/);
  assert.match(read("public/onboarding.html"), /href="\/site-nav.css"/);
  assert.ok(readdirSync(new URL("../public", import.meta.url)).includes("site-nav.js"));
});

test("look: one shared file owns the accent colours, canvas and shadow, and every header page can reach it", () => {
  const look = read("public/look.css");
  for (const v of ["--fun-teal", "--fun-amber", "--app-canvas", "--app-shadow"]) assert.ok(look.includes(v + ":"), v);
  assert.match(read("public/site-nav.css"), /^@import url\("\/look.css"\);/);
  assert.match(read("public/app.css"), /^@import url\("\/look.css"\);/);
  assert.doesNotMatch(read("public/app.css"), /\n:root\[data-app-theme="white"\]\{--app-canvas/);
  assert.doesNotMatch(read("public/home.css"), /\n\.nav nav \{/);
  assert.ok(read("src/http/sign-in-page.mjs").includes("data-site-nav"));
  for (const page of [...HEADER_PAGES]) {
    const html = read(`public/${page}.html`);
    assert.ok(html.includes("/theme-boot.js") && html.includes("/setup-theme.css"), page + " loads the theme");
  }
});
