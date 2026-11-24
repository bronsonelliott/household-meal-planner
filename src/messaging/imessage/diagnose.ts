// What `bun run doctor --online` says about iMessage. It pings the server and looks up the
// configured chat, and nothing else: no message is ever sent as a probe.

import { BlueBubblesApi, chatLookupPath, describeAnswer } from "./client.ts";
import { readServerInfo } from "./normalize.ts";
import type { IMessageAdapterConfig } from "./settings.ts";

export interface IMessageDiagnosis {
  problems: string[];
  lines: string[];
}

export async function diagnoseIMessage(config: IMessageAdapterConfig): Promise<IMessageDiagnosis> {
  const api = new BlueBubblesApi(config.serverUrl, config.password, config.requestTimeoutMs);
  const lines: string[] = [];
  const problems: string[] = [];

  const ping = await api.call("ping");
  if (ping.kind !== "ok") {
    const wrongPassword = ping.kind === "api-error" && (ping.httpStatus === 401 || ping.httpStatus === 403);
    problems.push(
      wrongPassword
        ? "imessage: the BlueBubbles server rejected the password. Check the environment variable named by messaging.imessage.passwordEnv."
        : `imessage: could not reach the BlueBubbles server (${describeAnswer(ping)}). Is the Mac awake, BlueBubbles running, and messaging.imessage.serverUrl right?`,
    );
    return { problems, lines };
  }
  lines.push("BlueBubbles server: reachable, password accepted");

  const info = await api.call("server/info");
  if (info.kind === "ok") {
    const summary = readServerInfo(info.body);
    lines.push(`BlueBubbles server version: ${summary.version ?? "not reported"}, macOS ${summary.macVersion ?? "?"}`);
    if (config.sendMethod === "private-api" && summary.privateApi !== true) {
      problems.push('imessage: sendMethod is "private-api" but the server says its Private API is not enabled. Turn it on in BlueBubbles, or set sendMethod = "apple-script".');
    }
  } else {
    lines.push(`BlueBubbles server info: not available (${describeAnswer(info)})`);
  }

  if (config.mode === "group" && config.chatGuid) {
    const chat = await api.call(chatLookupPath(config.chatGuid));
    if (chat.kind !== "ok") problems.push(`imessage: the household chat ${config.chatGuid} cannot be opened (${describeAnswer(chat)}). Check messaging.imessage.chatGuid.`);
    else lines.push(`Household chat: found "${chat.body?.data?.displayName || config.chatGuid}"`);
  }
  if (process.platform !== "darwin") {
    lines.push("This computer is not a Mac. That is fine as long as it can reach the server's address: BlueBubbles itself has to run on a Mac.");
  }
  lines.push("Not checked here: that messages are really delivered. BlueBubbles can accept a send before Messages finishes it.");
  return { problems, lines };
}
