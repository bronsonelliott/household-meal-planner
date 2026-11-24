// Runs the shared messaging contract against every adapter we have.

import { fakeKit, imessageKit, signalKit, telegramKit, whatsappKit } from "./fixtures/contract-kits.ts";
import { runMessagingContract } from "./messaging-contract.ts";

runMessagingContract("FakeAdapter", fakeKit, { realTransport: false });
runMessagingContract("Signal adapter (fake signal-cli)", signalKit);
runMessagingContract("Telegram adapter (fake Bot API)", telegramKit);
runMessagingContract("WhatsApp adapter (fake Graph API)", whatsappKit, { groups: false });
runMessagingContract("iMessage adapter (fake BlueBubbles server)", imessageKit);
