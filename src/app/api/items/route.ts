import { readDb, writeDb } from "@/lib/store";
export async function GET() {
  return Response.json(await readDb());
}
export async function DELETE() {
  await writeDb({ items: [], batches: [] });
  return Response.json({ ok: true });
}
