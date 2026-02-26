import { initDatabase, getTableSchema } from "@/lib/duckdb";

export const maxDuration = 30;

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return new Response(JSON.stringify({ error: "No file provided" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
    if (file.size > MAX_FILE_SIZE) {
      return new Response(JSON.stringify({ error: "File too large (max 100MB)" }), {
        status: 413,
        headers: { "Content-Type": "application/json" },
      });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    if (buffer.length === 0) {
      return new Response(JSON.stringify({ error: "File is empty" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    await initDatabase(buffer, "data", file.name);
    const schema = await getTableSchema("data");

    return new Response(
      JSON.stringify({
        success: true,
        filename: file.name,
        ...schema,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
