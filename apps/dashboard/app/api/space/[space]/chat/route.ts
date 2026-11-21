// Read-only chat for one space. Same identity and jail as Today:
// requireSpace(space, 'read') checks the Clerk session and membership, then the
// home view is read through the viewer's jailed runner. Nothing here writes.
//
// Slice 2: a model writes the answer through Vercel AI Gateway, grounded in the
// home view. A request that cannot be undone never reaches the model: it comes
// back as a proposal from the rules. If the model is off or fails, the rules
// answer instead, so chat never goes blank.
import { streamText } from 'ai';
import { buildView } from '../../../../../../../src/http/view.mjs';
import { requireSpace } from '../../../../../lib/server/auth';
import {
  answer, buildContext, chatModel, cleanHistory, isIrreversible, systemPrompt, toChunks, toModelMessages,
} from '../../../../../lib/chat-model.mjs';

export const dynamic = 'force-dynamic';

const HEADERS = { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' };
const line = (o: unknown) => JSON.stringify(o) + '\n';

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

  let view: unknown;
  try {
    view = await buildView(viewer.redis, viewer.namespace, 'home', { person: viewer.person }, Date.now());
  } catch {
    // Say the data is unavailable. Never answer from an empty view as if it were true.
    const reply = { text: 'LogMem could not read this space, so I have no answer. Nothing ran. Try again.' };
    return ndjson(toChunks(reply), 'none');
  }

  const model = chatModel(process.env);
  if (!model || isIrreversible(history)) return ndjson(toChunks(answer(history, view)), 'rules');

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      c.enqueue(enc.encode(line({ t: 'meta', provider: 'model', model })));
      let wrote = false;
      let failed = false;
      try {
        const result = streamText({
          model,
          system: systemPrompt(buildContext(view)),
          messages: toModelMessages(history) as any,
          maxOutputTokens: 500,
          temperature: 0.2,
          abortSignal: AbortSignal.any([req.signal, AbortSignal.timeout(30_000)]),
          onError() { failed = true; },
        });
        for await (const part of result.textStream) {
          if (!part) continue;
          wrote = true;
          c.enqueue(enc.encode(line({ t: 'token', v: part })));
        }
      } catch {
        failed = true;
      }
      if (!wrote) {
        // The model gave nothing. Answer from the rules so the person still gets the facts.
        c.enqueue(enc.encode(line({ t: 'meta', provider: 'rules' })));
        for (const chunk of toChunks(answer(history, view))) c.enqueue(enc.encode(line(chunk)));
      } else {
        if (failed) c.enqueue(enc.encode(line({ t: 'token', v: ' [The model stopped early. Nothing ran.]' })));
        c.enqueue(enc.encode(line({ t: 'done' })));
      }
      c.close();
    },
  });
  return new Response(stream, { headers: { ...HEADERS, 'x-chat-provider': 'model' } });
}

function ndjson(chunks: unknown[], provider: string) {
  const body = chunks.map(line).join('');
  return new Response(line({ t: 'meta', provider }) + body, { headers: { ...HEADERS, 'x-chat-provider': provider } });
}
