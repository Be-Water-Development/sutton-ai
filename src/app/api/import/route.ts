import { readDb, writeDb } from "@/lib/store";
import { validateAll, toItem, type RawRow } from "@/lib/importer";

// Authoritative commit: re-validate everything server-side, import the valid rows, report the rest.
export async function POST(req: Request) {
  const { rows, fileName, rowNumbers, mode } = (await req.json()) as { rows: RawRow[]; fileName: string; rowNumbers: number[]; mode?: "insert" | "upsert" };
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
  db.items = [...db.items.filter((i) => !incoming.has(i.sku)), ...imported];
  const batch = { id: crypto.randomUUID(), at: new Date().toISOString(), fileName, imported: imported.length, updated, skipped: rejected.length };
  db.batches.unshift(batch);
  await writeDb(db);
  return Response.json({ batch, imported, rejected, total: db.items.length });
}
