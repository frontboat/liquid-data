import { connectTorii } from "./torii.js";
import { createMcpAgent } from "./agent.js";
import { listWorlds } from "./list-worlds.js";

export async function queryWorld(question: string, toriiUrl?: string): Promise<string> {
  if (!toriiUrl) {
    const worlds = await listWorlds({});
    if (worlds.length === 0) return "No active worlds found. Provide a torii_url directly.";
    const lines = worlds.map(
      (w) => `- ${w.name} [${w.chain}] (${w.status})\n  torii_url: ${w.toriiUrl}`,
    );
    return `No torii_url provided. Available worlds:\n\n${lines.join("\n\n")}\n\nCall query-world again with one of these torii_url values.`;
  }

  const conn = await connectTorii(toriiUrl);
  const agent = createMcpAgent({ url: conn.baseUrl, tables: conn.tables });
  const result = await agent.generate({
    prompt: question,
    onStepFinish: ({ usage }) => {
      const d = usage.inputTokenDetails;
      console.error(`[cache] write=${d?.cacheWriteTokens ?? 0} read=${d?.cacheReadTokens ?? 0} noCache=${d?.noCacheTokens ?? 0} input=${usage.inputTokens} output=${usage.outputTokens}`);
    },
  });
  return result.text;
}
