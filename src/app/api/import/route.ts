import { readDb, writeDb } from "@/lib/store";
import { validateAll, toItem, type Item, type RawRow } from "@/lib/importer";

// Authoritative commit: re-validate everything server-side, import the valid rows, report the rest.
export async function POST(req: Request) {
  const { rows, fileName, rowNumbers, mode, fields } = (await req.json()) as { rows: RawRow[]; fileName: string; rowNumbers: number[]; mode?: "insert" | "upsert"; fields?: string[] };
  const db = await readDb();
  const existing = mode === "upsert" ? new Set<string>() : new Set(db.items.map((i) => i.sku));
  const errors = validateAll(rows, existing);
  const imported = [];
  const rejected = [];
  for (let i = 0; i < rows.length; i++) {
    if (errors[i].length) rejected.push({ rowNumber: rowNumbers?.[i] ?? i + 1, row: rows[i], errors: errors[i] });
    else imported.push(toItem(rows[i]));
  }
  const incoming = new Set(imported.map((i) => i.sku));
  const updated = db.items.filter((i) => incoming.has(i.sku)).length;
  // Upsert: only overwrite what this file actually has columns for; keep everything else on the existing item.
  const itemKeys = new Set(
    (fields ?? []).map((f) => (f.startsWith("vendor_") ? "vendors" : ["length", "width", "height", "dimension_unit"].includes(f) ? "dimensions" : f)),
  );
  const merged = imported.map((item) => {
    const old = db.items.find((i) => i.sku === item.sku);
    if (!old || !fields) return item;
    const out: Record<string, unknown> = { ...old };
    for (const k of Object.keys(item) as (keyof Item)[]) if (itemKeys.has(k)) out[k] = item[k];
    for (const k of itemKeys) if (!(k in item)) delete out[k]; // mapped but now empty
    return out as Item;
  });
  db.items = [...db.items.filter((i) => !incoming.has(i.sku)), ...merged];
  const batch = { id: crypto.randomUUID(), at: new Date().toISOString(), fileName, imported: imported.length, updated, skipped: rejected.length };
  db.batches.unshift(batch);
  await writeDb(db);
  return Response.json({ batch, imported: merged, rejected, total: db.items.length });
}
