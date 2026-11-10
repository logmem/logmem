// Server-side authorization for the dashboard.
// Identity is the Clerk session cookie, checked in-process by the same
// customerSession the root /api/session route uses (it also asks Clerk whether
// the session was revoked). Sign-in is the Clerk <SignIn /> page at /sign-in.
// A signed-in person who is not a member of the space is sent to the
// access-denied page. Membership failures are not missing pages.
// A Clerk or storage failure is thrown so the error boundary can show it.
import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { customerSession } from '../../../../src/http/clerk.mjs';
import { listViewerWorkspaces, resolveDashboardViewer } from './viewer';
import {
  ACCESS_DENIED_PATH,
  isMembershipDenial,
  isSignInRequired,
  safeReturnTo,
  SELECT_SPACE_PATH,
  spacePath,
  validSpaceId,
} from './routes.mjs';

type Session = { status: string; userId?: string; email?: string; sessionId?: string };

function nodeRequest() {
  const h = headers();
  return {
    headers: {
      cookie: h.get('cookie') ?? '',
      host: h.get('host') ?? 'logmem.si',
      origin: h.get('origin') ?? '',
      'x-forwarded-proto': h.get('x-forwarded-proto') ?? 'https',
    },
  };
}

export { safeReturnTo, spacePath, validSpaceId };

export function signInHref(returnTo: string): string {
  return `/sign-in?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
}

function redirectForAccessError(error: unknown, returnTo: string): never {
  if (isSignInRequired(error)) redirect(signInHref(returnTo));
  if (isMembershipDenial(error)) redirect(ACCESS_DENIED_PATH);
  throw error;
}

/** Verified session, or a redirect to sign-in. Expired auth is never shown as "denied". */
export async function requireSession(returnTo: string) {
  const req = nodeRequest();
  const origin = `${req.headers['x-forwarded-proto']}://${req.headers.host}`;
  let session: Session;
  try {
    session = (await customerSession(req, {
      env: process.env,
      url: new URL('/api/session', origin).toString(),
    })) as Session;
  } catch {
    // Service failure is not a sign-out. Surface it to the error boundary.
    throw new Error('session_unavailable');
  }
  if (session.status !== 'signed-in' || !session.userId) redirect(signInHref(returnTo));
  return { req, session: session as Required<Pick<Session, 'userId'>> & Session };
}

/** Workspaces and spaces this person may see. */
export async function listMySpaces(returnTo = SELECT_SPACE_PATH) {
  const { session } = await requireSession(returnTo);
  return listViewerWorkspaces(session.userId);
}

/**
 * Authorizes one space for one action. Cached per request, so the layout and the
 * page share one Clerk check.
 * Signed out -> sign-in. Not a member, unknown space, or a role that cannot
 * take the action -> access denied. Storage and configuration failures throw.
 */
export const requireSpace = cache(async (space: string, action: 'read' | 'write' | 'approve' = 'read') => {
  const returnTo = spacePath(space, 'today');
  const { req, session } = await requireSession(returnTo);
  if (!validSpaceId(space)) redirect(ACCESS_DENIED_PATH);

  let workspaces;
  try {
    workspaces = await listViewerWorkspaces(session.userId);
  } catch (error) {
    redirectForAccessError(error, returnTo);
  }
  const workspace = workspaces.find((w) => w.spaces.some((s) => s.id === space));
  if (!workspace) redirect(ACCESS_DENIED_PATH);

  try {
    return await resolveDashboardViewer(
      { workspaceId: workspace.id, spaceId: space, action, req },
      { session: async () => session },
    );
  } catch (error) {
    redirectForAccessError(error, returnTo);
  }
});
