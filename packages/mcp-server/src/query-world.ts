import { connectTorii } from "./torii.js";
import { createMcpAgent } from "./agent.js";

export async function queryWorld(question: string, toriiUrl?: string): Promise<string> {
  const conn = toriiUrl ? await connectTorii(toriiUrl) : undefined;
  const agent = createMcpAgent(conn);
  const result = await agent.generate({ prompt: question });
  return result.text;
}
