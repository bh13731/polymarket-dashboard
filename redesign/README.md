# Redesign preview — The Speculator's Ledger

A redesign of the polymarket-agent dashboard, hosted as a sibling at
`/redesign/` so it survives the hourly auto-mirror that rewrites the root
`index.html`.

**Preview**: https://bh13731.github.io/polymarket-dashboard/redesign/

This page is a **frozen** snapshot — its `data.json` was extracted from the
mirror at the time of the redesign and is not refreshed. Real-time data
will land here once the equivalent renderer ships in
[polymarket-agent](https://github.com/bh13731/polymarket-agent).

## Files

- `index.html` — page structure
- `styles.css` — typography, colour, layout
- `app.js` — D3 charts, sortable tables, decision aggregation, filter
- `data.json` — frozen data extracted from a mirror snapshot

## Aesthetic

Editorial newspaper meets private bank: warm-paper palette, Fraunces
italic for hero numbers, Bricolage Grotesque for UI, JetBrains Mono for
data. Two editions — the night (default dark) and the morning (cream)
— toggleable from the masthead.
