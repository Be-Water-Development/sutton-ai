import { askJson, aiEnabled } from "@/lib/ai";
import { CATEGORIES, UOMS, type FieldError, type RawRow } from "@/lib/importer";

type In = { id: number; row: RawRow; errors: FieldError[] };
export type Suggestion = { id: number; field: string; value: string; reason: string; confidence: "high" | "medium" | "low" };

export async function POST(req: Request) {
  if (!aiEnabled()) return Response.json({ error: "AI is not configured (set OPENROUTER_API_KEY)" }, { status: 400 });
  const { rows } = (await req.json()) as { rows: In[] };
  const compact = rows.slice(0, 40).map((r) => ({
    id: r.id,
    errors: r.errors,
    row: Object.fromEntries(Object.entries(r.row).filter(([, v]) => v !== "")),
  }));
  try {
    const out = await askJson<{ suggestions: Suggestion[] }>(
      `You help a warehouse admin fix invalid rows in an inventory import. Rules:
- sku: ^[A-Z]{4}-[A-Z0-9]{3}$ and unique. Never invent a SKU; if it's missing or unrecoverable, skip it.
- name: 1-120 chars. If missing, you may propose one derived from the description.
- category: one of ${CATEGORIES.join(", ")}. Infer from name/description when the value is wrong.
- uom: one of ${UOMS.join(", ")}.
- unit_cost: decimal >= 0, up to 4 dp. Never guess a price; skip "TBD" or negatives unless obviously a sign typo (then confidence low).
- integers >= 0; booleans true/false; dates YYYY-MM-DD; tags lowercase ';' separated unique.
- discontinued_on set => is_active must be false. Only one vendor preferred.
Only propose a fix when you have a real basis for it. Fewer, correct suggestions beat guesses.`,
      `Rows with errors (JSON):\n${JSON.stringify(compact)}\n\nReturn {"suggestions":[{"id":<row id>,"field":"<field key>","value":"<new value>","reason":"<short why>","confidence":"high|medium|low"}]}`,
    );
    return Response.json(out);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
