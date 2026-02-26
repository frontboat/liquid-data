import { createAgent, createToriiAgent } from "@/lib/agent";
import { getTableSchema, isDataLoaded } from "@/lib/duckdb";
import { isToriiConnected } from "@/lib/torii";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { pipeJsonRender } from "@json-render/core";

export const maxDuration = 60;

export async function POST(req: Request) {
  const body = await req.json();
  const uiMessages: UIMessage[] = body.messages;

  if (!uiMessages || !Array.isArray(uiMessages) || uiMessages.length === 0) {
    return new Response(
      JSON.stringify({ error: "messages array is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  let agent;

  if (isToriiConnected()) {
    agent = createToriiAgent();
  } else {
    const loaded = await isDataLoaded();
    if (!loaded) {
      return new Response(
        JSON.stringify({ error: "No data loaded. Please upload a file or connect to Torii first." }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const schema = await getTableSchema("data");
    agent = createAgent({
      columns: schema.columns,
      rowCount: schema.rowCount,
    });
  }

  const modelMessages = await convertToModelMessages(uiMessages);
  const result = await agent.stream({ messages: modelMessages });

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.merge(pipeJsonRender(result.toUIMessageStream()));
    },
  });

  return createUIMessageStreamResponse({ stream });
}
