# Inventory Bulk Import

A local web app that lets a warehouse ops admin get a messy spreadsheet export into inventory — and trust exactly what got in and what didn't — without going back to the spreadsheet.

## Run it

Requires Node 20+ (tested on Node 24).

```bash
npm install
echo "OPENROUTER_API_KEY=sk-or-..." > .env.local   # optional: enables the AI features
npm run dev
```

Open http://localhost:3000 and click **items_messy.csv** under “Try a sample” (or drag in any CSV).

Tests: `npm test`

Optional: `OPENROUTER_MODEL` (default `openai/gpt-4.1-mini`). Without a key everything works except the ✨ AI buttons, which say how to enable them.

Imported items are stored in `data/inventory.json` (gitignored). Use the “reset” link in the header (upload screen) to clear it.

## The flow

1. **Upload** – drag & drop a **CSV or Excel file** (.xlsx/.xls/.ods; real date cells become YYYY-MM-DD), or pick a sample (`samples/items_messy.xlsx` is there to try Excel). Nothing is saved until you confirm. In-progress work survives a page refresh.
2. **Match columns** – headers are matched automatically (`"SKU "`, `Unit Cost ($)`, `Active?`, `Reorder Pt`…). Anything we can't match by name is sent to AI with sample values, which proposes a field. Every mapping shows where it came from: **name match** (rules, no AI), **✨ AI: reason**, or **set by you**. Columns like `Internal Notes` default to “Don't import”. Missing required fields are called out.
3. **Review & fix**
   - Safe fixes are applied automatically and shown in amber with the original struck through + **undo**: SKU case/separators, `$15.39`, `1,200`, decimal comma `20,34`, `TRUE/yes/1`, `05/09/2024` / `Oct 24, 2024` → ISO, category/UoM synonyms (`Raw Material`, `bx`), tag case/dupes, whitespace.
   - Anything that would be a guess (`TBD` cost, negative cost, `12.5` qty, `2024-13-01`, `Misc` category, missing SKU) is **not** auto-fixed — it's flagged in red with a plain-English reason.
   - **Issues by type** sidebar groups problems (“SKU is duplicated in this file — 10 rows”); click to filter.
   - Click any cell to edit (dropdowns for enums/booleans). **Enter/Tab saves and jumps to the next problem cell**, Esc cancels. Re-validation is instant, including SKU uniqueness across the file **and existing inventory**.
   - Fix one bad value and it offers to **fix every row with the same value**.
   - **✨ Suggest fixes** asks AI for proposals on the remaining rows (e.g. infer category from item name); each is shown inline with confidence and reason; accept one-by-one or all. AI never changes data silently and is told never to invent SKUs or prices.
   - One-click fixes per issue group: keep first duplicate & exclude later copies, mark discontinued items inactive, keep the cheapest vendor as the single preferred one, clear partial dimensions, or exclude the group.
   - SKUs already in inventory: tick **update them with this file** to upsert instead of skipping (receipt shows how many were updated).
   - Exclude rows you don't want. A sticky footer always says exactly what will happen: “164 of 200 rows will be imported, 36 skipped”.
4. **Done** – a receipt: how many imported (and how many were cleaned up), every row not imported with its reasons, and the imported items. **Fix the remaining rows here** puts the rejects straight back into review; or download them as a CSV with an `import_errors` column.

## Design decisions

- **One validation module** (`src/lib/importer.ts`) runs in the browser for instant feedback and again on the server at commit, so what the UI promises is what the server enforces.
- **Partial import**: valid rows go in, invalid rows come back with reasons. The admin isn't blocked by 3 bad rows out of 200.
- **Deterministic first, AI second**: rules handle the unambiguous stuff (fast, free, explainable); AI only gets what's left, and only as suggestions.
- `MM/DD/YYYY` is assumed for slash dates (US spreadsheet export); the change is visible and undoable.

## What's next (not done in the hour)

- Real database + import batches with undo/rollback.
- Saved column mappings per source, virtualized grid for 10k+ rows.
