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
3. **Cleaned up** – every value fixed by deterministic rules (no AI), shown as original → cleaned with the reason: whitespace (made visible), SKU case/separators, `$15.39`, `1,200`, decimal comma `20,34`, `TRUE/yes/1`, `05/09/2024` / `Oct 24, 2024` → ISO, category/UoM synonyms (`Raw Material`, `bx`), tag case/dupes. **Keep original** undoes a fix (and **Use cleaned value** redoes it). Anything that would be a guess (`TBD` cost, negative cost, `12.5` qty, `2024-13-01`, `Misc` category, missing SKU) is left for step 4.
4. **Fix issues** – one line per problem: row, field, value, plain-English problem. Click a value to edit (dropdowns for enums/booleans); **Enter** saves and jumps to the next problem. Fixing one value offers to fix every row with the same bad value. **See full row** opens the whole row in a modal for context. **✨ Suggest fixes** sends all unsolved problems to AI (via OpenRouter) and adds Proposed value / Reason / Accept / Dismiss columns — suggestions are checked against the rules first, and nothing changes until you accept. A big **ready to import** counter counts up as problems are solved.
5. **Confirm** – exactly what will be imported: counts (straight from file / cleaned up / fixed by you / excluded / still broken → skipped), a preview with touched cells highlighted (green = rule fix, blue = your fix), **See full row**, and an option to **update existing items** when SKUs are already in inventory (only mapped fields are overwritten).
6. **Done** – a receipt: how many imported (and how many were cleaned up), every row not imported with its reasons, and the imported items. **Fix the remaining rows here** puts the rejects straight back into review; or download them as a CSV with an `import_errors` column.

## Design decisions

- **One validation module** (`src/lib/importer.ts`) runs in the browser for instant feedback and again on the server at commit, so what the UI promises is what the server enforces.
- **Partial import**: valid rows go in, invalid rows come back with reasons. The admin isn't blocked by 3 bad rows out of 200.
- **Deterministic first, AI second**: rules handle the unambiguous stuff (fast, free, explainable); AI only gets what's left, and only as suggestions.
- `MM/DD/YYYY` is assumed for slash dates (US spreadsheet export); the change is visible and undoable.

## What's next (not done in the hour)

- Real database + import batches with undo/rollback.
- Saved column mappings per source, virtualized grid for 10k+ rows.
