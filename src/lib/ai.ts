// Server-only OpenRouter helper (key never reaches the browser).
const BASE_URL = "https://openrouter.ai/api/v1";
export const MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4.1-mini";
export const aiEnabled = () => !!process.env.OPENROUTER_API_KEY;

export async function askJson<T>(system: string, user: string): Promise<T> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system + "\nReply with a single JSON object and nothing else." },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return JSON.parse(String(data.choices[0].message.content).replace(/^```(json)?|```$/g, "").trim());
}
