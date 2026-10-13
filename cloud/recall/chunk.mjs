// chunk.mjs — split text into ~800-char windows with 100 chars of overlap,
// preferring to cut at whitespace so words are not split across chunks.

export function chunkText(text, { size = 800, overlap = 100 } = {}) {
  const s = String(text ?? "");
  if (overlap >= size) throw new Error("chunkText: overlap must be smaller than size");
  if (s.length <= size) return [s];
  const out = [];
  let start = 0;
  while (start < s.length) {
    let end = Math.min(start + size, s.length);
    if (end < s.length) {
      const ws = s.lastIndexOf(" ", end);
      const nl = s.lastIndexOf("\n", end);
      const cut = Math.max(ws, nl);
      if (cut > start + size - overlap) end = cut;
    }
    out.push(s.slice(start, end));
    if (end >= s.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}
