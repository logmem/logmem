// apps/dashboard/lib/server/auth.ts
// N1: real server-side authorization for the dashboard.
// Identity is the Clerk session cookie, checked in-process by the same
// customerSession the root /api/session route uses (it also asks Clerk whether
// the session was revoked). Sign-in is the Clerk <SignIn /> page at /sign-in.
// Denied is not hidden: a signed-in person outside the space gets notFound().
import 'server-only';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { customerSession } from '../../../../src/http/clerk.mjs';
import { listViewerWorkspaces, resolveDashboardViewer } from './viewer';

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

/** Only same-site /app paths may be a sign-in return target. */
export function safeReturnTo(path: string): string {
  return /^\/app(\/[A-Za-z0-9._~-]*)*$/.test(path) ? path : '/app';
}

export function signInHref(returnTo: string): string {
  return `/sign-in?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
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
export async function listMySpaces(returnTo = '/app') {
  const { session } = await requireSession(returnTo);
  return listViewerWorkspaces(session.userId);
}

/**
 * Authorizes one space for one action. Signed out -> sign-in. Not a member,
 * or no such space -> 404. Same answer for both, so ids do not leak.
 */
export async function requireSpace(space: string, action: 'read' | 'write' | 'approve' = 'read') {
  const { req, session } = await requireSession(`/app/${space}/today`);
  const workspaces = await listViewerWorkspaces(session.userId);
  const workspace = workspaces.find((w) => w.spaces.some((s) => s.id === space));
  if (!workspace) notFound();
  try {
    return await resolveDashboardViewer(
      { workspaceId: workspace.id, spaceId: space, action, req },
      { session: async () => session },
    );
  } catch {
    notFound();
  }
}
