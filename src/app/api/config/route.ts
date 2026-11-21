import { aiEnabled, MODEL } from "@/lib/ai";
export async function GET() {
  return Response.json({ aiEnabled: aiEnabled(), model: MODEL });
}
