import { parseFlags, wantsHelp } from "../args.js";
import { saveCliCredentials } from "../client.js";

export const USAGE = `Usage: gateway login --url <gateway-url> --token <admin-api-key>`;

export async function loginCommand(argv: string[]): Promise<number> {
  if (wantsHelp(argv)) {
    console.log(USAGE);
    return 0;
  }
  const { flags } = parseFlags(argv);
  const url = typeof flags.url === "string" ? flags.url : "";
  const token = typeof flags.token === "string" ? flags.token : "";
  if (!url || !token) {
    console.error(USAGE);
    return 1;
  }
  await saveCliCredentials({ url, token });
  console.log(`Logged in to ${url}`);
  return 0;
}
