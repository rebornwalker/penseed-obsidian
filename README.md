# Penseed Obsidian Plugin

Penseed is a narrative consistency tool for novelists. This plugin sends the
current note to Penseed for AI analysis of foreshadowing and entity
consistency, then directs you to the Penseed web app to manage the full
foreshadowing loop.

## What it does

Run **Penseed: Analyze Current Note** from the command palette to:

1. Bind the current note to a Penseed project and create a chapter (metadata only — the note body is never stored).
2. Run AI foreshadowing extraction and entity extraction.
3. Show the number of candidates found and a link to continue on Penseed.

## Privacy

When you choose to analyze a note, the plugin sends the content of that note
to Penseed for narrative consistency analysis. The content is used only as an
analysis parameter and is not stored by Penseed. The plugin does not read or
upload any other files, does not watch your vault, and does not collect
telemetry.

Privacy policy: https://penseed.app/privacy

## Setup

1. Install the plugin.
2. In **Settings → Penseed**, set the API URL (default `https://api.penseed.app`).
3. Sign in to Penseed, copy your access token, and save it under **Penseed access token**. The token expires after ~60 minutes and must be re-pasted.

## Development

```bash
npm install
npm run build   # type-check + produce main.js
```

## License

MIT. See LICENSE.
