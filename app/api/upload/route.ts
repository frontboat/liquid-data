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

    const content = await file.text();

    if (!content.trim()) {
      return new Response(JSON.stringify({ error: "File is empty" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    await initDatabase(content, "data", file.name);
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
