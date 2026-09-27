/** Test helpers: SSE bodies from strings, split into arbitrary chunks. */
import { readSse, type SseEvent } from '../src/background/sse.js';

/** A ReadableStream that yields `text` in chunks of `size` bytes (splitting UTF-8 and lines anywhere). */
export function streamOf(text: string, size = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

/** Anthropic-style SSE text from a list of JSON payloads (event name = payload.type). */
export function anthropicSse(payloads: Array<Record<string, unknown>>): string {
  return payloads.map((payload) => `event: ${String(payload['type'])}\ndata: ${JSON.stringify(payload)}\n\n`).join('');
}

/** OpenAI-style SSE text: `data:` lines, optionally ending with [DONE]. */
export function openaiSse(chunks: Array<Record<string, unknown>>, done = true): string {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');
}

export async function events(text: string, size?: number): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const event of readSse(streamOf(text, size))) out.push(event);
  return out;
}
