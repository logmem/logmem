// email-preview.mjs — render every email template with sample values.
// Writes one .html and one .txt per template plus an index page. Sends nothing.
//
// Usage: node scripts/email-preview.mjs <output directory>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TEMPLATES, SAMPLES } from "../src/email/templates.mjs";
import { escapeHtml } from "../src/email/layout.mjs";

export function renderPreviews() {
  return Object.keys(TEMPLATES).map((name) => ({ name, ...TEMPLATES[name](SAMPLES[name]) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2];
  if (!out) {
    process.stderr.write("Usage: node scripts/email-preview.mjs <output directory>\n");
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  const all = renderPreviews();
  for (const p of all) {
    writeFileSync(join(out, `${p.name}.html`), p.html);
    writeFileSync(join(out, `${p.name}.txt`), `Subject: ${p.subject}\n\n${p.text}`);
  }
  const rows = all.map((p) => `<li><a href="${p.name}.html">${escapeHtml(p.name)}</a> · <a href="${p.name}.txt">text</a><br><small>${escapeHtml(p.subject)}</small></li>`).join("\n");
  writeFileSync(join(out, "index.html"), `<!doctype html><meta charset="utf-8"><title>LogMem email previews</title><body style="font-family:sans-serif;max-width:640px;margin:40px auto;line-height:1.6"><h1>LogMem email previews</h1><p>Sample values only. Nothing here was sent.</p><ul>${rows}</ul></body>`);
  process.stdout.write(`Wrote ${all.length} previews to ${out}\n`);
}
