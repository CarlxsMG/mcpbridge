import { parseFlags } from "../args.js";
import { saveCliCredentials } from "../client.js";

export async function loginCommand(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  const url = typeof flags.url === "string" ? flags.url : "";
  const token = typeof flags.token === "string" ? flags.token : "";
  if (!url || !token) {
    console.error(`Usage: gateway login --url <gateway-url> --token <admin-api-key>`);
    return 1;
  }
  await saveCliCredentials({ url, token });
  console.log(`Logged in to ${url}`);
  return 0;
}
