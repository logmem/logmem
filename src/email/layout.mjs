// layout.mjs — one branded shell for every LogMem email.
//
// Colors and type come from public/ds/tokens/logmem.css. Email clients do not
// read CSS variables or web fonts reliably, so the light values are inlined and
// the dark values sit in one style block for clients that honor it.
// No images: the mark is drawn with table cells, so nothing is blocked or
// fetched from our servers. Every value from a caller is escaped.
//
// A template passes blocks. renderEmail returns { html, text } with the same
// content in both, so the plain-text part is never an afterthought.

export const BRAND = Object.freeze({
  bg: "#F4F6F5", surface: "#FFFFFF", sunken: "#EAEEEC", border: "#D3DAD8",
  text: "#121A19", muted: "#46534F", subtle: "#5C6966",
  brand: "#0E6863", onBrand: "#FFFFFF", link: "#0B5E59", brandSubtle: "#DDF1EE",
  mark: "#121A19", markCarry: "#4FC3B8", markLine: "#E9EEEC",
  dark: {
    bg: "#0C1211", surface: "#121A19", sunken: "#080D0C", border: "#2B3835",
    text: "#E9EEEC", muted: "#B3BEBA", subtle: "#97A4A0",
    brand: "#4FC3B8", onBrand: "#06201E", link: "#6FD2C7", brandSubtle: "#0F2D2A",
  },
});

const SANS = "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const DISPLAY = `'Schibsted Grotesk', ${SANS}`;
const SITE = "https://logmem.si";

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Only https links leave a LogMem email. Anything else becomes the site root. */
export function safeUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === "https:" ? u.toString() : SITE;
  } catch {
    return SITE;
  }
}

// The LogMem symbol as a 32px table: three log lines and the carry dot.
const bar = (width, color, cls) => `<tr><td style="padding:0 0 3px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="${cls}" width="${width}" height="4" style="width:${width}px;height:4px;line-height:4px;font-size:0;background:${color};border-radius:1px;">&nbsp;</td></tr></table></td></tr>`;
const MARK = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" aria-hidden="true"><tr><td width="32" height="32" style="width:32px;height:32px;background:${BRAND.mark};border-radius:7px;padding:7px 0 0 5px;vertical-align:top;"><table role="presentation" cellpadding="0" cellspacing="0" border="0">${bar(15, BRAND.markLine, "lm-mark-line")}${bar(10, BRAND.markLine, "lm-mark-line")}${bar(14, BRAND.markCarry, "lm-mark-carry")}</table></td></tr></table>`;

const P = `margin:0 0 16px 0;font-family:${SANS};font-size:16px;line-height:24px;color:${BRAND.text};`;

function blockHtml(b) {
  if (typeof b === "string") return `<p class="lm-text" style="${P}">${escapeHtml(b)}</p>`;
  if (b.type === "heading") return `<h2 class="lm-text" style="margin:24px 0 8px 0;font-family:${DISPLAY};font-size:18px;line-height:24px;font-weight:700;color:${BRAND.text};">${escapeHtml(b.text)}</h2>`;
  if (b.type === "list") return `<ul class="lm-text" style="margin:0 0 16px 0;padding:0 0 0 20px;font-family:${SANS};font-size:16px;line-height:24px;color:${BRAND.text};">${b.items.map((i) => `<li style="margin:0 0 6px 0;">${escapeHtml(i)}</li>`).join("")}</ul>`;
  if (b.type === "note") return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;"><tr><td class="lm-note" style="background:${BRAND.brandSubtle};border-left:3px solid ${BRAND.brand};border-radius:4px;padding:12px 16px;font-family:${SANS};font-size:15px;line-height:22px;color:${BRAND.text};">${escapeHtml(b.text)}</td></tr></table>`;
  if (b.type === "button") {
    const href = escapeHtml(safeUrl(b.url));
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px 0;"><tr><td class="lm-btn" style="background:${BRAND.brand};border-radius:6px;"><a class="lm-btn-a" href="${href}" style="display:inline-block;padding:13px 22px;font-family:${SANS};font-size:16px;line-height:20px;font-weight:600;color:${BRAND.onBrand};text-decoration:none;">${escapeHtml(b.label)}</a></td></tr></table><p class="lm-muted" style="margin:-12px 0 16px 0;font-family:${SANS};font-size:13px;line-height:20px;color:${BRAND.subtle};">Or open this link: <a class="lm-link" href="${href}" style="color:${BRAND.link};">${href}</a></p>`;
  }
  if (b.type === "signature") return `<p class="lm-text" style="margin:24px 0 0 0;font-family:${SANS};font-size:16px;line-height:24px;color:${BRAND.text};">${b.lines.map(escapeHtml).join("<br>")}</p>`;
  throw new Error(`unknown email block: ${b?.type}`);
}

function blockText(b) {
  if (typeof b === "string") return b;
  if (b.type === "heading") return b.text;
  if (b.type === "list") return b.items.map((i) => `- ${i}`).join("\n");
  if (b.type === "note") return b.text;
  if (b.type === "button") return `${b.label}: ${safeUrl(b.url)}`;
  if (b.type === "signature") return b.lines.join("\n");
  throw new Error(`unknown email block: ${b?.type}`);
}

/**
 * @param {object} o
 * @param {string} o.title      The heading inside the card.
 * @param {string} o.preheader  The preview line a mail client shows after the subject.
 * @param {Array}  o.blocks     Strings (paragraphs) or { type: heading|list|note|button|signature }.
 * @param {string} [o.footer]   Why the reader got this email.
 */
export function renderEmail({ title, preheader = "", blocks, footer = "You get this email because you have a LogMem account." }) {
  if (!title || !Array.isArray(blocks) || blocks.length === 0) throw new Error("an email needs a title and at least one block");
  const d = BRAND.dark;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(title)}</title>
<style>
@media (prefers-color-scheme: dark) {
  .lm-bg { background: ${d.bg} !important; }
  .lm-card { background: ${d.surface} !important; border-color: ${d.border} !important; }
  .lm-text { color: ${d.text} !important; }
  .lm-muted { color: ${d.subtle} !important; }
  .lm-link { color: ${d.link} !important; }
  .lm-note { background: ${d.brandSubtle} !important; border-left-color: ${d.brand} !important; color: ${d.text} !important; }
  .lm-btn { background: ${d.brand} !important; }
  .lm-btn-a { color: ${d.onBrand} !important; }
  .lm-rule { border-top-color: ${d.border} !important; }
}
@media (max-width: 620px) { .lm-pad { padding: 24px 20px !important; } }
</style>
</head>
<body class="lm-bg" style="margin:0;padding:0;background:${BRAND.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" class="lm-bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.bg};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
<tr><td style="padding:0 0 20px 4px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;">${MARK}</td>
<td class="lm-text" style="vertical-align:middle;padding-left:10px;font-family:${DISPLAY};font-size:20px;line-height:24px;font-weight:800;color:${BRAND.text};letter-spacing:-0.2px;">LogMem</td>
</tr></table>
</td></tr>
<tr><td class="lm-card lm-pad" style="background:${BRAND.surface};border:1px solid ${BRAND.border};border-radius:10px;padding:32px 36px;">
<h1 class="lm-text" style="margin:0 0 20px 0;font-family:${DISPLAY};font-size:24px;line-height:30px;font-weight:800;color:${BRAND.text};letter-spacing:-0.3px;">${escapeHtml(title)}</h1>
${blocks.map(blockHtml).join("\n")}
</td></tr>
<tr><td style="padding:20px 4px 0 4px;">
<p class="lm-muted" style="margin:0 0 6px 0;font-family:${SANS};font-size:13px;line-height:20px;color:${BRAND.subtle};">${escapeHtml(footer)}</p>
<p class="lm-muted" style="margin:0;font-family:${SANS};font-size:13px;line-height:20px;color:${BRAND.subtle};">LogMem is shared memory and signed decisions for agent teams. <a class="lm-link" href="${SITE}" style="color:${BRAND.link};">logmem.si</a> · <a class="lm-link" href="${SITE}/privacy" style="color:${BRAND.link};">Privacy</a> · <a class="lm-link" href="${SITE}/terms" style="color:${BRAND.link};">Terms</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  const text = [title, "", ...blocks.map(blockText).flatMap((t) => [t, ""]), "--", footer, `LogMem · ${SITE}`, ""].join("\n");
  return { html, text };
}
