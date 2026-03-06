import { connectTorii } from "./torii.js";
import { createMcpAgent } from "./agent.js";
import { listWorlds } from "./list-worlds.js";

export async function queryWorld(question: string, toriiUrl?: string): Promise<string> {
  if (toriiUrl) {
    // Pre-connected: agent gets this URL and its table listing
    const conn = await connectTorii(toriiUrl);
    const agent = createMcpAgent([], { url: conn.baseUrl, tables: conn.tables });
    const result = await agent.generate({
      prompt: question,
      onStepFinish: ({ usage }) => {
        const d = usage.inputTokenDetails;
        console.error(`[cache] write=${d?.cacheWriteTokens ?? 0} read=${d?.cacheReadTokens ?? 0} noCache=${d?.noCacheTokens ?? 0} input=${usage.inputTokens} output=${usage.outputTokens}`);
      },
    });
    return result.text;
  }

  // No URL: discover worlds and let the agent pick
  const worlds = await listWorlds({});
  const worldList = worlds.map((w) => ({ name: w.name, toriiUrl: w.toriiUrl }));
  const agent = createMcpAgent(worldList);
  const result = await agent.generate({
    prompt: question,
    onStepFinish: ({ usage }) => {
      const d = usage.inputTokenDetails;
      console.error(`[cache] write=${d?.cacheWriteTokens ?? 0} read=${d?.cacheReadTokens ?? 0} noCache=${d?.noCacheTokens ?? 0} input=${usage.inputTokens} output=${usage.outputTokens}`);
    },
  });
  return result.text;
}
