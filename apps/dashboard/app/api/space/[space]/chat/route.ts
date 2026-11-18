// Read-only chat for one space. Same identity and jail as Today:
// requireSpace(space, 'read') checks the Clerk session and membership, then the
// home view is read through the viewer's jailed runner. Nothing here writes.
import { buildView } from '../../../../../../../src/http/view.mjs';
import { requireSpace } from '../../../../../lib/server/auth';
import { answer, cleanHistory, toChunks } from '../../../../../lib/chat-model.mjs';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  // Not inside the try: a sign-in or access-denied redirect must reach Next.js.
  const viewer = await requireSpace(space, 'read');

  let body: { history?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const history = cleanHistory(body?.history);
  if (!history) return Response.json({ error: 'bad_history' }, { status: 400 });

  let reply;
  try {
    const view = await buildView(viewer.redis, viewer.namespace, 'home', { person: viewer.person }, Date.now());
    reply = answer(history, view);
  } catch {
    // Say the data is unavailable. Never answer from an empty view as if it were true.
    reply = { text: 'LogMem could not read this space, so I have no answer. Nothing ran. Try again.' };
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      for (const chunk of toChunks(reply)) c.enqueue(enc.encode(JSON.stringify(chunk) + '\n'));
      c.close();
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-chat-provider': 'space-memory' },
  });
}
