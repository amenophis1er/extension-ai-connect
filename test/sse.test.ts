import { describe, expect, it } from 'vitest';
import { events } from './helpers.js';

describe('readSse', () => {
  it('parses named events whatever the chunk boundaries, including split UTF-8', async () => {
    const text = 'event: a\ndata: {"t":"héllo ✓"}\n\nevent: b\ndata: 2\n\n';
    for (const size of [1, 2, 3, 5, 64]) {
      expect(await events(text, size)).toEqual([{ event: 'a', data: '{"t":"héllo ✓"}' }, { event: 'b', data: '2' }]);
    }
  });

  it('accepts CRLF and CR line ends, skips comments, joins multi-line data', async () => {
    const text = ': keep-alive\r\nevent: x\r\ndata: one\r\ndata: two\r\n\r\ndata:three\r\r';
    expect(await events(text, 3)).toEqual([{ event: 'x', data: 'one\ntwo' }, { event: 'message', data: 'three' }]);
  });

  it('discards an event cut off by the end of the stream', async () => {
    expect(await events('data: complete\n\ndata: {"cut":', 4)).toEqual([{ event: 'message', data: 'complete' }]);
  });
});
