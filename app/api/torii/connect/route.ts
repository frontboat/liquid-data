import { connectTorii, disconnectTorii } from "@/lib/torii";

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const { url } = await req.json();

    if (!url || typeof url !== "string") {
      return Response.json({ error: "url is required" }, { status: 400 });
    }

    const result = await connectTorii(url);
    return Response.json({
      success: true,
      tables: result.tables.map((t) => ({
        name: t.name,
        columnCount: t.columns.length,
      })),
      tableCount: result.tables.length,
    });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE() {
  disconnectTorii();
  return Response.json({ success: true });
}
