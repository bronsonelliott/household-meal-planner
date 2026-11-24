// What `bun run doctor --online` says about WhatsApp. It reads the phone number's record and nothing
// else: no message is ever sent as a probe.

import { describeAnswer, GraphApi } from "./client.ts";
import type { WhatsAppAdapterConfig } from "./settings.ts";

export interface WhatsAppDiagnosis {
  problems: string[];
  lines: string[];
}

export async function diagnoseWhatsApp(config: WhatsAppAdapterConfig): Promise<WhatsAppDiagnosis> {
  const api = new GraphApi(config.accessToken, [config.appSecret, config.verifyToken], config.apiBaseUrl, config.apiVersion, config.requestTimeoutMs);
  const lines: string[] = [];
  const problems: string[] = [];

  const answer = await api.call(`${config.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`);
  if (answer.kind !== "ok") {
    problems.push(`whatsapp: could not read the phone number (${describeAnswer(answer)}). Check the access token, the phone number ID, and that nothing blocks graph.facebook.com.`);
    return { problems, lines };
  }
  lines.push(`WhatsApp number: ${answer.body?.verified_name ?? "(no name yet)"}, ${answer.body?.display_phone_number ?? "?"} (token accepted)`);
  lines.push(`WhatsApp quality rating: ${answer.body?.quality_rating ?? "not reported"}`);
  lines.push("Not checked here: that Meta can reach your webhook address. Meta's dashboard has a Test button for that, and the bridge log shows each call.");
  return { problems, lines };
}
