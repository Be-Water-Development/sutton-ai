# Inventory Bulk Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web app where a warehouse ops admin drops a messy CSV, gets headers mapped and safe fixes applied automatically (with a visible diff), fixes the remaining bad rows inline, sees exactly what will import, commits, and gets a clear receipt of what got in and what didn't.

**Architecture:** One npm package. `shared/` holds pure TS (header mapping, normalization/auto-fix, validation) used by both the React client (live re-validation while editing) and the Express server (authoritative validation on commit). Server persists items to `data/inventory.json` and proxies AI calls to OpenRouter so the key never reaches the browser.

**Tech Stack:** Node 24, Vite + React + TypeScript, Express (run via tsx), papaparse (CSV with quoted newlines), vitest.

**Spec:** Take-home brief (Item schema + CSV encoding), `samples/schema.json`, `samples/items_clean.csv`, `samples/items_messy.csv`.

## Global Constraints

- Runs locally; README has exact commands (`npm install`, `npm run dev`).
- `OPENROUTER_API_KEY` read from env only; app fully works without it (AI buttons disabled with a hint).
- sku: `^[A-Z]{4}-[A-Z0-9]{3}$`, unique across file AND existing records.
- name 1–120 chars after trim. category ∈ raw-materials, components, finished-goods, packaging, supplies. uom ∈ EA, BX, KG, M, L.
- unit_cost ≥ 0, ≤ 4 dp. quantity_on_hand int ≥ 0 default 0. reorder_point int ≥ 0.
- is_active default true; lot_tracked default false; discontinued_on set ⇒ is_active false.
- tags `;`-separated, lowercase, unique. dates YYYY-MM-DD.
- dimensions: length/width/height all-or-none, each > 0; dimension_unit cm|in default cm.
- vendors ≤ 3, vendor_N_{name,sku,unit_cost,lead_time_days,preferred}; name + unit_cost required; ≤ 1 preferred.
- Commit frequently; zip without node_modules before 5:53 PM EST.

## Review Focus

- Multiline/quoted descriptions in CSV → must stay one row (papaparse, test with clean file = 25 rows).
- Duplicate SKU within file → both rows flagged, not silently dropped; SKU already in inventory → flagged "already exists".
- Auto-fix must never guess when ambiguous (e.g. `01/02/2024` day/month ambiguity → only fix when unambiguous or consistent with file); every fix listed as from → to.
- Editing a cell re-validates that row AND sku-uniqueness across the file immediately.
- Commit with some invalid rows → valid rows import, invalid rows returned with reasons + downloadable CSV of rejects.

---

### Task 1: Scaffold + shared schema/validation

**Files:** `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `shared/schema.ts`, `shared/validate.ts`, `shared/validate.test.ts`

**Interfaces — Produces:**
- `FIELDS: FieldDef[]` (`{ key, label, required, aliases: string[] }`) for every flat CSV column (incl. `length`, `dimension_unit`, `vendor_1_name`…).
- `type RawRow = Record<string, string>` (flat canonical keys → cell text).
- `validateRow(row: RawRow): FieldError[]` where `FieldError = { field: string; message: string }`.
- `toItem(row: RawRow): Item` (canonical nested JSON).
- `findDuplicateSkus(rows: RawRow[], existing: Set<string>): Map<number, string>` (row index → message).

- [ ] Tests: clean sample → every row zero errors; `sku:"pack-7q2"` → error on sku; discontinued_on + is_active true → error; 2 preferred vendors → error; length set without width → error.
- [ ] Implement, `npx vitest run` passes, commit.

### Task 2: Header mapping + auto-fix (shared)

**Files:** `shared/mapping.ts`, `shared/autofix.ts`, tests alongside.

**Interfaces — Produces:**
- `guessMapping(headers: string[]): Record<string, string | null>` (source header → field key; normalized-name + alias match).
- `autofixRow(row: RawRow): { row: RawRow; changes: Change[] }`, `Change = { field; from; to; reason }`.

Fixes (only unambiguous): trim/collapse whitespace; sku uppercase + separator normalize (`pack 7q2`, `PACK_7Q2` → `PACK-7Q2`); category/uom synonyms & case (`Raw Materials`, `each`, `box`, `kgs`, `liter`); money strip `$`/`,`/`USD`; ints `1,200`→`1200`, `12.0`→`12`; booleans yes/no/y/n/1/0/TRUE; dates `MM/DD/YYYY`, `YYYY/MM/DD`, `Mon D, YYYY` → ISO; tags lowercase, dedupe, split on `,` or `|` too; dimension_unit `inch(es)`/`"`→`in`; discontinued_on set & is_active blank → false.

- [ ] Tests for each fix class + a value that must NOT be changed (e.g. `abc` cost stays `abc`).
- [ ] Run messy file through: print error count before/after. Commit.

### Task 3: Server

**Files:** `server/index.ts`, `server/ai.ts`, `data/` (gitignored json).

- `GET /api/items`, `DELETE /api/items` (reset for demo), `POST /api/import {rows: RawRow[]}` → re-validate (incl. existing SKUs) → `{ imported: Item[], rejected: {index, row, errors}[] }`.
- `POST /api/ai/map {headers, samples}` → mapping for headers left unmapped.
- `POST /api/ai/fix {rows:[{row, errors}]}` → suggested corrected values per row (returned as proposals, never auto-applied silently).
- `GET /api/config` → `{ aiEnabled }`.
- [ ] curl smoke test, commit.

### Task 4: UI flow (the bulk of the hour)

**Files:** `src/App.tsx`, `src/steps/Upload.tsx`, `src/steps/Mapping.tsx`, `src/steps/Review.tsx`, `src/steps/Done.tsx`, `src/styles.css`.

1. **Upload:** drag-drop/browse, "try sample" buttons, shows existing inventory count.
2. **Mapping:** auto-mapped table (source header → field dropdown, sample values, confidence badge), "Ask AI" for unmapped, required-field-missing warning.
3. **Review:** summary chips (Ready / Auto-fixed / Needs attention / Duplicates); filter tabs; grid with inline editable cells, red cells w/ tooltip error, yellow cells for auto-fixed (hover shows from→to); "Fix all similar" (apply a value change to every row with the same bad value); "AI suggest fixes" for error rows with accept/reject; exclude row toggle; sticky footer "Import N items (M will be skipped)".
4. **Done:** receipt — N imported, M skipped with reasons, download rejected rows as CSV (to fix and re-upload), view imported inventory table, "import another file".

- [ ] Manual run with messy file end-to-end, commit after each step.

### Task 5: README + zip

- [ ] README: commands, features, decisions, what's next. `git archive`-style zip excluding node_modules. Commit.
