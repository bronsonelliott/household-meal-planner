// A stand-in for the Anthropic SDK client. Each messages.create() call takes the next script off
// the queue and plays it back, recording exactly what the caller sent. No network, no model.

import type { ClientFactory, MessageParams, MessageResponse, MessagesClient } from "../../src/brain/claude.ts";

export interface Script {
  // The response to return.
  response?: MessageResponse;
  // Throw this instead (an API error, a network failure).
  throws?: unknown;
  // Never finish: wait until the call's abort signal fires (the wall-clock abort).
  hang?: boolean;
}

export interface RecordedCall {
  params: MessageParams;
  signal: AbortSignal | undefined;
  apiKey: string; // the key the client was built with
  // Shortcuts the brain tests read.
  prompt: string;
  system: string;
}

export class FakeAnthropic {
  calls: RecordedCall[] = [];
  private scripts: Script[] = [];

  push(...scripts: Script[]): this {
    this.scripts.push(...scripts);
    return this;
  }

  // Hand this to createClaudeCaller as clientFactory.
  factory: ClientFactory = (apiKey) => {
    const client: MessagesClient = {
      messages: {
        create: async (params, options) => {
          const script = this.scripts.shift();
          if (!script) throw new Error("FakeAnthropic: no script left for this call");
          this.calls.push({ params, signal: options?.signal, apiKey, prompt: params.messages[0]!.content, system: params.system });
          if (script.hang) {
            const signal = options?.signal;
            await new Promise<void>((resolve) => {
              if (signal?.aborted) resolve();
              signal?.addEventListener("abort", () => resolve());
            });
            throw new Error("Request was aborted.");
          }
          if (script.throws !== undefined) throw script.throws;
          return script.response!;
        },
      },
    };
    return client;
  };
}

// An error shaped like the SDK's APIError: a message and an HTTP status.
export function apiError(status: number, message: string): Error {
  return Object.assign(new Error(`${status} ${message}`), { status });
}

export function textResponse(text: string): MessageResponse {
  return { content: [{ type: "text", text }] };
}

// The usual good call: a response carrying the given text.
export function answer(text: string): Script {
  return { response: textResponse(text) };
}
