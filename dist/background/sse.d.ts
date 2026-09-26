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
export declare function readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent>;
