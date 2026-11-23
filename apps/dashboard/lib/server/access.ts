import 'server-only';
import { buildView } from '../../../../src/http/view.mjs';
import { requireSpace } from './auth';
import { buildAccessFlags, buildConnectSnippets } from '../access-model.mjs';

export interface AccessFlag {
  id: string;
  label: string;
  hint: string;
  envVar: string;
  value: string;
  tone: 'ok' | 'warn' | 'danger' | 'neutral';
}

export interface ConnectSnippet {
  id: string;
  label: string;
  command: string;
  note: string;
}

export interface AccessData {
  flags: AccessFlag[];
  snippets: ConnectSnippet[];
  unavailable: boolean;
}

export async function getAccessData(space: string): Promise<AccessData> {
  const viewer = await requireSpace(space, 'read');
  const now = Date.now();
  const snippets = buildConnectSnippets(space) as ConnectSnippet[];
  try {
    const view: any = await buildView(viewer.redis, viewer.namespace, 'settings', {}, now);
    return {
      flags: buildAccessFlags(view, space) as AccessFlag[],
      snippets,
      unavailable: false,
    };
  } catch {
    return { flags: [], snippets, unavailable: true };
  }
}
