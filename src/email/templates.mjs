// templates.mjs — every LogMem email, in one place, in the brand layout.
//
// Each template returns { subject, text, html }. None of them sends anything:
// pass the result to sendEmail in src/http/resend.mjs.
// Copy follows the LogMem writing standard: plain words, short sentences,
// the main point first.
import { renderEmail, safeUrl } from "./layout.mjs";

const SIGN_IN = "https://logmem.si/sign-in";
const clean = (v, max = 120) => String(v ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
const day = (v) => clean(v, 40);

/** Sent when someone joins the waitlist. */
export function waitlistConfirmation({ email }) {
  const subject = "You are on the LogMem waitlist";
  return {
    subject,
    ...renderEmail({
      title: "You are on the waitlist",
      preheader: "We will email you when access opens.",
      footer: "You get this email because this address joined the LogMem waitlist.",
      blocks: [
        `We added ${clean(email, 254)} to the LogMem waitlist.`,
        "We will email this address when access opens. You do not need to do anything now.",
        { type: "note", text: "LogMem is shared memory and signed decisions for agent teams." },
      ],
    }),
  };
}

/** Sent when a waitlist address gets access. */
export function waitlistInvite({ link }) {
  const subject = "Your LogMem workspace is ready";
  return {
    subject,
    ...renderEmail({
      title: "Your workspace is ready",
      preheader: "Sign in with this email address to open it.",
      footer: "You get this email because this address joined the LogMem waitlist.",
      blocks: [
        "You can now sign in to LogMem with this email address.",
        { type: "button", label: "Open your workspace", url: link },
        "If you did not ask for access, ignore this email. Nothing happens until you sign in.",
      ],
    }),
  };
}

/** Sent when a workspace owner invites a person. */
export function workspaceInvite({ workspaceName = "a workspace", link }) {
  const name = clean(workspaceName, 80) || "a workspace";
  const subject = `You are invited to ${name} on LogMem`;
  return {
    subject,
    ...renderEmail({
      title: `Join ${name}`,
      preheader: "Sign in with this email address to accept.",
      footer: "You get this email because a LogMem workspace owner invited this address.",
      blocks: [
        `You are invited to ${name} on LogMem.`,
        "Sign in with this email address to accept the invitation.",
        { type: "button", label: "Accept the invitation", url: link },
        "This link expires in seven days.",
      ],
    }),
  };
}

/**
 * Sent by hand after a sign-in outage, to a person whose account records we moved.
 * Apology first, then what happened, the fix, and one request.
 */
export function signInOutageApology({ name, from, to, movedOn, senderName, replyTo, signInUrl = SIGN_IN }) {
  const who = clean(name, 60);
  const subject = "Sorry about the LogMem sign-in outage. It is fixed, and I need one check from you";
  return {
    subject,
    ...renderEmail({
      title: "Sorry about the sign-in outage",
      preheader: "It is fixed. Please sign in once and tell me your workspace looks right.",
      blocks: [
        who ? `Hi ${who},` : "Hi,",
        `I owe you an apology. From ${day(from)} to ${day(to)} you could not sign in to LogMem. That was our mistake, not anything you did.`,
        { type: "heading", text: "What happened" },
        "We moved LogMem sign-in from a test system to our permanent one. The switch went live before the accounts were moved across, so the new system did not know who you were.",
        { type: "heading", text: "What we did to fix it" },
        { type: "list", items: [
          `We moved your account and your workspace to the permanent sign-in system on ${day(movedOn)}.`,
          "The move did not delete or change anything in your workspace.",
          "Google and GitHub sign-in work again. An email code works too.",
          "We now sign in with a real account before and after any change to the sign-in system.",
        ] },
        { type: "heading", text: "What I need from you" },
        "Please sign in and look at your workspace. It takes two minutes. Use the same email address as before.",
        { type: "button", label: "Sign in to LogMem", url: signInUrl },
        "Then reply to this email with one line: \"all good\", or tell me what looks wrong. If an old password is refused, choose the email code option.",
        "Thank you for staying with us while we are this early, and for your patience. It matters a lot.",
        { type: "signature", lines: [clean(senderName, 60), "LogMem", clean(replyTo, 120)].filter(Boolean) },
      ],
    }),
  };
}

/** Sent by hand to early account holders: thanks, a short outage note, and how to sign in now. */
export function earlyUserThanks({ from, to, launchDate, senderName, replyTo, signInUrl = SIGN_IN }) {
  const subject = "Thank you for being one of the first people on LogMem";
  return {
    subject,
    ...renderEmail({
      title: "Thank you for being early",
      preheader: "A short update on sign-in, and a thank you.",
      blocks: [
        "Hi,",
        "You are one of the first people to create a LogMem account. Thank you. Early users are the reason this product gets better, and we do not take that for granted.",
        { type: "heading", text: `Sign-in was down from ${day(from)} to ${day(to)}` },
        "We moved sign-in from a test system to our permanent one, and the switch went live too early. If you tried to sign in on those days, it failed. I am sorry about that. It is fixed.",
        { type: "heading", text: "What is different now" },
        { type: "list", items: [
          "Sign-in runs on our permanent system.",
          "Google and GitHub sign-in work. An email code works too.",
          "Use the same email address as before. If an old password is refused, choose the email code option.",
        ] },
        { type: "button", label: "Sign in to LogMem", url: signInUrl },
        "If you sign in and anything looks wrong, reply to this email. I read every reply myself.",
        ...(launchDate ? [`We launch publicly on ${day(launchDate)}. You were here before that, and I will not forget it.`] : []),
        { type: "signature", lines: ["Thank you,", clean(senderName, 60), "LogMem", clean(replyTo, 120)].filter(Boolean) },
      ],
    }),
  };
}

export const TEMPLATES = Object.freeze({ waitlistConfirmation, waitlistInvite, workspaceInvite, signInOutageApology, earlyUserThanks });

/** Example values for previews and tests. No real person is named here. */
export const SAMPLES = Object.freeze({
  waitlistConfirmation: { email: "person@example.com" },
  waitlistInvite: { link: "https://logmem.si/app?setup=managed&signin=1" },
  workspaceInvite: { workspaceName: "Acme Operations", link: "https://logmem.si/app?invite=example" },
  signInOutageApology: { name: "Sam", from: "November 8", to: "November 10", movedOn: "November 10", senderName: "Michael Shaw", replyTo: "hello@logmem.si" },
  earlyUserThanks: { from: "November 8", to: "November 10", launchDate: "November 18", senderName: "Michael Shaw", replyTo: "hello@logmem.si" },
});

export { safeUrl };
