// The one place that knows which adapters exist. Everything else asks for "the adapter for this
// config" and gets back a MessagingAdapter.

import type { AppConfig } from "../config.ts";
import { SignalAdapter } from "./signal/adapter.ts";
import { signalAdapterConfig } from "./signal/settings.ts";
import { IMessageAdapter } from "./imessage/adapter.ts";
import { imessageAdapterConfig } from "./imessage/settings.ts";
import { WhatsAppAdapter } from "./whatsapp/adapter.ts";
import { whatsappAdapterConfig } from "./whatsapp/settings.ts";
import { TelegramAdapter } from "./telegram/adapter.ts";
import { telegramAdapterConfig } from "./telegram/settings.ts";
import type { MessagingAdapter } from "./types.ts";

export function createAdapter(config: AppConfig, env: Record<string, string | undefined> = process.env): MessagingAdapter {
  switch (config.messaging.platform) {
    case "signal":
      return new SignalAdapter(signalAdapterConfig(config, env));
    case "telegram":
      return new TelegramAdapter(telegramAdapterConfig(config, env));
    case "whatsapp":
      return new WhatsAppAdapter(whatsappAdapterConfig(config, env));
    case "imessage":
      return new IMessageAdapter(imessageAdapterConfig(config, env));
  }
}
