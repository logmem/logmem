---
name: logmem-decisions
description: Ask a person before anything irreversible, wait for the answer, and act only on approve. Use before sending, spending, deleting, merging, deploying, publishing or changing a secret or account setting, and to make a decision someone gave in chat verifiable.
---

# LogMem decisions

An agent never decides for a person. Before anything that cannot be undone, ask in LogMem and wait. Act only when the answer is **approve**. Only a person can write a decision: an agent that tries to write kind `decided` is refused.

## When this skill applies

Ask before you:

- send anything to someone outside the team (email, DM, SMS, a post)
- spend money
- delete anything
- merge to main, or deploy
- publish (site copy, store text, social posts, packages)
- change a secret, a key or an account setting

## 1. Ask

One ask covers one action. Never bundle several actions into one yes: the person must be able to approve one and reject another.

```text
logmem_ask {
  "question": "Send issue 14 to 2,184 subscribers on Tue at 9 am?",
  "action": "POST the issue-14 campaign to the newsletter list 'main', scheduled Tue 09:00 ET.",
  "where": "job:issue-14",
  "origin": "<trail this follows from>"
}
```

- `question`: one plain yes/no question.
- `action`: the exact thing you will do on approve, with the command, recipients and amount. Not a summary.
- `where`: the job or channel. The default is your agent log.
- `reversible`: `true` only if the action can be fully undone. Otherwise leave it out: the person then types "approve" to confirm.
- `to`: leave it out unless one named person must answer.

Keep the `trail` from the reply. Then **stop**: do not do the action, and do not ask again.

## 2. Wait, then read the answer

The person answers on the LogMem web app, Decisions page. On every start, read your Brief:

- `pending_asks`: still waiting. A deferred ask stays here with the person's note: keep waiting.
- `answered_asks`: each has a `verdict` and the person's note.

## 3. Act on the verdict

| Verdict | Do |
|---|---|
| `approve` | Do exactly the `action` you asked, nothing more. Then log it with `origin` set to the ask's trail. |
| `reject` | Do not do it. Write one line that you stopped, with the note if there is one. |
| still pending | Nothing. Do not chase. |

```text
logmem_note { "where": "job:issue-14", "kind": "done", "origin": "<ask trail>", "summary": "Sent the approved issue-14 campaign." }
```

## 4. Decisions given in chat

People often decide in a chat. Other agents cannot verify a line that says "they approved". So:

1. Never write that a person approved something unless their answer is in your Brief, or the message is in their own words on the thread.
2. Until that confirm ask is answered, the interim record is a `memo` that quotes the person's own words and names the source, and says in it that no `decided` entry exists. A memo records what was said; it is not a decision, and it is never a reason to skip the confirm ask.
3. To make a chat decision verifiable, open a confirm ask. The person approves it in one click:

```text
logmem_ask {
  "question": "Confirm your chat decision: LogMem replaces Entry as the single lane?",
  "action": "Record the lane as LogMem in the team lane record. No other change.",
  "where": "channel:agent-coordination",
  "reversible": true
}
```

## Mistakes to avoid

- Acting while the ask is pending.
- Asking again because there is no answer yet.
- Bundling several actions into one ask.
- Writing "approved" without the answer in your Brief.
- Acting on the verdict of a different ask. Match the trail.

## Verify

1. After asking: `logmem_brief` lists your ask under `pending_asks`.
2. After the answer: it moves to `answered_asks` with a verdict.
3. After acting: your `done` entry has `origin` equal to the ask's trail.
