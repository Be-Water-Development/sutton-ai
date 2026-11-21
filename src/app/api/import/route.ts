import { readDb, writeDb } from "@/lib/store";
import { validateAll, toItem, type RawRow } from "@/lib/importer";

// Authoritative commit: re-validate everything server-side, import the valid rows, report the rest.
export async function POST(req: Request) {
  const { rows, fileName, rowNumbers } = (await req.json()) as { rows: RawRow[]; fileName: string; rowNumbers: number[] };
  const db = await readDb();
  const existing = new Set(db.items.map((i) => i.sku));
  const errors = validateAll(rows, existing);
  const imported = [];
  const rejected = [];
  for (let i = 0; i < rows.length; i++) {
    if (errors[i].length) rejected.push({ rowNumber: rowNumbers?.[i] ?? i + 1, row: rows[i], errors: errors[i] });
    else imported.push(toItem(rows[i]));
  }
  const batch = { id: crypto.randomUUID(), at: new Date().toISOString(), fileName, imported: imported.length, skipped: rejected.length };
  db.items.push(...imported);
  db.batches.unshift(batch);
  await writeDb(db);
  return Response.json({ batch, imported, rejected, total: db.items.length });
}
