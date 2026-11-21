import { promises as fs } from "node:fs";
import path from "node:path";
import type { Item } from "./importer";

const FILE = path.join(process.cwd(), "data", "inventory.json");

export type Batch = { id: string; at: string; fileName: string; imported: number; skipped: number };
type Db = { items: Item[]; batches: Batch[] };

export async function readDb(): Promise<Db> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8"));
  } catch {
    return { items: [], batches: [] };
  }
}
export async function writeDb(db: Db) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(db, null, 2));
}
