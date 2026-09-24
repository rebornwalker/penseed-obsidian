# Penseed Obsidian Plugin

**Never lose a plot thread — no matter how long your novel gets.**

Penseed is a consistency companion for novelists. It reads each chapter as you
write it, remembers every planted thread, character detail, and world rule, and
quietly warns you before a contradiction slips past.

## The problem with long novels

Most writing tools get worse the longer your book becomes. They work by
re-reading your entire manuscript from page one every time you ask for help — so
at chapter 50 they feel slow, at chapter 200 they feel expensive, and at chapter
500 they start forgetting what happened in chapter 3.

Penseed works the opposite way. **It remembers as you write**, like a tireless
editor who has read every chapter and never forgets a single detail. Analyzing
chapter 500 never means re-reading chapters 1 through 499.

| | A typical writing plugin | Penseed |
|---|---|---|
| How it remembers | Re-reads your whole book on every request | Reads each chapter once, then keeps tidy, organized notes on it |
| Finding a detail | Skims everything from the start | Recalls only the relevant chapters |
| At 500+ chapters | Slow, costly, forgetful | Fast, affordable, precise |
| Foreshadowing | Not tracked | Plant → track → payoff, fully managed |

## What Penseed tracks for you

- **Foreshadowing** — the one thing almost no other tool does. Penseed remembers
  every thread you plant, tells you which ones are still dangling, and which
  ones you've already paid off.
- **Your cast and world** — characters, places, items: their names, aliases, and
  how they change chapter by chapter.
- **Contradictions** — if an eye color, a kingdom's history, or a magic rule
  quietly changes, Penseed flags it before your readers do.
- **World rules & reader knowledge** — so what each character knows stays
  consistent with what they *should* know.
- **Edits that ripple** — rewrite chapter 100 when you're already at chapter
  200, and Penseed tells you exactly which later chapters are affected, instead
  of making you re-check everything.

## How to use it

Run **Penseed: Analyze Current Note** from the command palette. Penseed will bind
the note to a project, analyze it, and show how many new threads and characters
it found.

Click the **layout-grid icon** in the left ribbon — or run **Penseed: Open
Foreshadowing Board** — to open a four-column board (Pending / In Progress /
Resolved / Cancelled). Drag a clue between columns to update its status, kept in
sync with the web app. For the full board with relations and editing, open the
web app.

## Privacy

When you choose to analyze a note, the plugin sends that note's content to
Penseed for analysis only. Penseed uses the text to build its notes about your
story and **never stores the original text itself**. The plugin does not read or
upload any other files, does not watch your vault, and does not collect
telemetry.

Privacy policy: https://penseed.app/privacy

## Setup

1. Install the plugin.
2. In **Settings → Penseed**, click **Connect Penseed**.
3. Your browser opens — sign in to Penseed with your Google account and click
   **Authorize**.
4. Switch back to Obsidian. You're connected. There's no token to copy, and your
   session renews automatically, so you won't be signed out.

## License

MIT. See LICENSE.
