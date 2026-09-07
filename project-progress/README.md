# Project progress

`index.html` is the canonical standalone visual project review. Open it directly in a browser; no server, installation or network is needed for the report. Evidence links need network access. Print / PDF uses the browser print dialog.

The **Light mode** toggle follows your system preference on first visit and remembers an explicit choice in browser storage. It remains usable if storage is unavailable. Print output stays light in either theme.

## Update procedure

1. Read root `AGENTS.md`. Refresh current Git/source/checks/CI and the relevant runtime or deployment source. Keep unavailable sources explicitly Unverified.
2. Edit `status.json`. Preserve IDs, historical completion dates and evidence. Use Complete, Partial, In Progress, Unverified, Pending, Not Started or Blocked. Complete requires an actual date and evidence. Future dates remain null and labeled Unscheduled until agreed. Remaining items are stored in dependency order; completed items render by actual date.
3. Set `verifiedAt`, `verifiedLabel` (ET) and `codeRevision` to the actual evidence sweep, not the render time. The HTML is a dated snapshot, never an automatic live monitor. Do not refresh an entire snapshot timestamp while silently retaining stale volatile claims; recheck them or disclose their older evidence time in notes.
4. Reconcile affected roadmap/ledger entries. Do not infer broader milestone completion from a smaller feature delivery. Keep product completion separate from documentation delivery.
5. Run `node project-progress/render.mjs` and `git diff --check`. The generator rejects invalid statuses, duplicate IDs and missing completion evidence. Run relevant application checks when product code changes.
6. View `index.html` at desktop and mobile widths. Check navigation, keyboard focus, readable tables, source links and print layout. Mobile tables intentionally scroll inside their labeled region.
7. Commit source and generated HTML together, push, and complete the applicable CI/merge workflow. Report the resulting identifiers. Do not claim public deployment for a local/repository document.

Change visual presentation in `render.mjs`, never directly in `index.html`. No secret values, private account data or transcript credentials belong in these files.
