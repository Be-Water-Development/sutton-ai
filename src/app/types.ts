import type { Change, FieldError, Item, RawRow } from "@/lib/importer";

export type WorkRow = {
  id: number; // 1-based row number in the source file
  row: RawRow; // current values (after auto-fix + user edits)
  original: RawRow; // values as they came out of the file (after header mapping)
  autoChanges: Change[];
  edited: Record<string, string>; // field -> value before the user's edit
  excluded: boolean;
};

export type Suggestion = { id: number; field: string; value: string; reason: string; confidence: "high" | "medium" | "low" };

export type ImportResult = {
  batch: { id: string; at: string; fileName: string; imported: number; skipped: number };
  imported: Item[];
  rejected: { rowNumber: number; row: RawRow; errors: FieldError[] }[];
  total: number;
  excluded: WorkRow[];
};
