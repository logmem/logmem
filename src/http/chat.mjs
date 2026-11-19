// src/http/chat.mjs
// One chat answer for one space, shared by the operator route (api/chat.mjs) and
// the customer boundary (customer-dashboard.mjs). Read only: no tools, no writes.
//
// Order matters:
// 1. A request that cannot be undone never reaches a model. The rules turn it
//    into a proposal that a person must approve, and approving runs nothing yet.
// 2. With gateway access, a model writes the answer from a compact snapshot of
//    the home view. Entry text is marked as data in the system prompt.
// 3. If the model is off, fails or returns nothing, the rules answer instead.
import {
  answer, buildContext, chatModel, cleanHistory, isIrreversible, systemPrompt, toModelMessages,
} from '../../apps/dashboard/lib/chat-model.mjs';

export class ChatInputError extends Error {
  constructor() { super('bad_history'); this.code = 'bad_history'; this.status = 400; }
}

async function defaultGenerate(opts) {
  const { generateText } = await import('ai');
  const r = await generateText(opts);
  return r.text;
}

/**
 * @param {unknown} rawHistory  client turns: [{role, text}]
 * @param {object} view         home view from buildView(..., 'home')
 * @param {{env?:object, now?:number, signal?:AbortSignal, generate?:Function}} deps
 * @returns {Promise<{provider:'rules'|'model', model?:string, text:string, action?:object}>}
 */
export async function chatReply(rawHistory, view, deps = {}) {
  const history = cleanHistory(rawHistory);
  if (!history) throw new ChatInputError();
  const env = deps.env || process.env;
  const now = deps.now ?? Date.now();
  const rules = () => ({ provider: 'rules', ...answer(history, view, now) });

  const model = chatModel(env);
  if (!model || isIrreversible(history)) return rules();

  try {
    const generate = deps.generate || defaultGenerate;
    const signals = [AbortSignal.timeout(30_000), deps.signal].filter(Boolean);
    const text = await generate({
      model,
      system: systemPrompt(buildContext(view), now),
      messages: toModelMessages(history),
      maxOutputTokens: 500,
      temperature: 0.2,
      abortSignal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    });
    const clean = String(text ?? '').trim();
    if (!clean) return rules();
    return { provider: 'model', model, text: clean.slice(0, 6000) };
  } catch {
    return rules();
  }
}
