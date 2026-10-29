import { NextRequest } from "next/server";
import { advisorName, clientsInScope, loadBook } from "@/lib/data";
import { runAgent, type RunEvent } from "@/lib/agent";
import { addRun, latestRun } from "@/lib/store";


function scopeLabel(scope: string) {
  if (scope === "ALL") return "Whole book";
  if (scope === "UNASSIGNED") return "Unassigned clients";
  return advisorName(loadBook(), scope);
}

export async function GET(req: NextRequest) {
  const scope = req.nextUrl.searchParams.get("scope") ?? "A01";
  return Response.json({ run: latestRun(scope) });
}

// Streams one NDJSON event per line so the UI can show the loop live.
export async function POST(req: NextRequest) {
  const { scope = "A01" } = await req.json().catch(() => ({}));
  const book = loadBook();
  const clients = clientsInScope(book, scope);
  const origin = req.nextUrl.origin;
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: RunEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      try {
        const run = await runAgent(book, scope, scopeLabel(scope), clients, origin, emit);
        addRun(run);
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" } });
}
