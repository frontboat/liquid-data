import { connectTorii } from "./torii.js";
import { createMcpAgent } from "./agent.js";

export async function handleQuery(question: string, toriiUrl: string): Promise<string> {
  const conn = await connectTorii(toriiUrl);
  const agent = createMcpAgent(conn);
  const result = await agent.generate({ prompt: question });
  return result.text;
}
