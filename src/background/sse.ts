/**
 * Server-Sent Events, parsed from a fetch body.
 *
 * Per the SSE spec: events are separated by a blank line; `event:` names the
 * event, `data:` lines are joined with "\n", lines starting with ":" are
 * comments (keep-alives), and "\r\n" / "\r" count as line ends. Chunks may
 * split anywhere — mid-line, mid-UTF-8 sequence — so bytes are decoded in
 * streaming mode and lines are only cut at a line end.
 */

export interface SseEvent {
  event: string;
  data: string;
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];

  const flush = (): SseEvent | undefined => {
    if (data.length === 0 && !event) return undefined;
    const out = { event: event || 'message', data: data.join('\n') };
    event = '';
    data = [];
    return out;
  };

  function* lines(final: boolean): Generator<string> {
    for (;;) {
      const match = /\r\n|\r|\n/.exec(buffer);
      // A lone "\r" at the very end may be the first half of "\r\n": wait for more.
      if (!match || (!final && match[0] === '\r' && match.index === buffer.length - 1)) return;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      yield line;
    }
  }

  function* handle(line: string): Generator<SseEvent> {
    if (line === '') {
      const out = flush();
      if (out) yield out;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const line of lines(false)) yield* handle(line);
    }
    buffer += decoder.decode();
    for (const line of lines(true)) yield* handle(line);
    // An event not closed by a blank line before EOF is incomplete: the SSE
    // spec discards it, and so do we — a cut stream must not look finished.
  } finally {
    reader.releaseLock();
  }
}
