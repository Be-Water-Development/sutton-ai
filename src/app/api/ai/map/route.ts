import { askJson, aiEnabled } from "@/lib/ai";
import { FIELDS } from "@/lib/importer";

export async function POST(req: Request) {
  if (!aiEnabled()) return Response.json({ error: "AI is not configured (set OPENROUTER_API_KEY)" }, { status: 400 });
  const { headers, samples, taken } = (await req.json()) as { headers: string[]; samples: Record<string, string[]>; taken: string[] };
  const fields = FIELDS.filter((f) => !taken.includes(f.key)).map((f) => `${f.key} (${f.label})`);
  try {
    const out = await askJson<{ mapping: Record<string, { field: string | null; reason: string }> }>(
      "You map spreadsheet columns to an inventory item schema for a warehouse import.",
      `Available target fields:\n${fields.join("\n")}\n\nUnmapped columns with sample values:\n${headers
        .map((h) => `- "${h}": ${JSON.stringify(samples[h] ?? [])}`)
        .join("\n")}\n\nFor each column pick the best target field key, or null if it shouldn't be imported (e.g. internal notes). Each field may be used once. Return {"mapping": {"<column>": {"field": "<key>|null", "reason": "<5-10 words>"}}}`,
    );
    return Response.json(out);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
