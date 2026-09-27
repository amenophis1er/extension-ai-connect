/**
 * chat() end to end against a fake chrome.storage and a mocked fetch: pinned
 * connections, the parallel_tool_calls retry, Stop, the ai-chat message op —
 * and the one-writer queue under interleaved storage calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chat, createAiMessageHandler } from '../src/background/index.js';
import { openaiSse, streamOf } from './helpers.js';

const STORAGE_KEY = 'aiConnections';
let local: Map<string, unknown>;

/** Storage whose calls take a random few ms, so unsynchronised read-modify-writes interleave. */
function installChrome() {
  local = new Map();
  const session = new Map<string, unknown>();
  const jitter = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 6));
  const area = (map: Map<string, unknown>) => ({
    async get(key: string | string[]) {
      await jitter();
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter((k) => map.has(k)).map((k) => [k, structuredClone(map.get(k))]));
    },
    async set(items: Record<string, unknown>) {
      await jitter();
      for (const [k, v] of Object.entries(items)) map.set(k, structuredClone(v));
    },
    async remove(key: string | string[]) { for (const k of Array.isArray(key) ? key : [key]) map.delete(k); },
  });
  (globalThis as any).chrome = { storage: { local: area(local), session: area(session) }, tabs: { create: async () => ({}) } };
}

function seed(connections: Array<Record<string, unknown>>, activeId: string | null = null) {
  local.set(STORAGE_KEY, { activeId, connections });
}

const conn = (id: string, extra: Record<string, unknown> = {}) => ({
  id, kind: 'openai-compatible', label: id, baseUrl: 'http://localhost:11434', model: 'gpt-oss:20b', apiKeyEnc: null, revision: 1, ...extra,
});

const sseResponse = (text: string) => new Response(streamOf(text, 13), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const toolCallStream = openaiSse([
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'browser', arguments: '{"action":"observe"}' } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
]);

beforeEach(() => installChrome());
afterEach(() => vi.unstubAllGlobals());

describe('chat()', () => {
  it('calls the pinned connection and returns its tool calls', async () => {
    seed([conn('a'), conn('b', { baseUrl: 'http://127.0.0.1:1234' })], 'a');
    const fetch = vi.fn(async () => sseResponse(toolCallStream));
    vi.stubGlobal('fetch', fetch);
    const result = await chat({ system: 's', messages: [{ role: 'user', content: 'go' }], tools: [], connectionId: 'b', connectionRevision: 1 });
    expect(result).toMatchObject({ ok: true, stopReason: 'tool_use', toolCalls: [{ id: 'c1', args: { action: 'observe' } }] });
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe('http://127.0.0.1:1234/v1/chat/completions');
  });

  it('refuses a pinned connection that is gone, or whose settings changed since the run started', async () => {
    seed([conn('a', { revision: 2 })], 'a');
    vi.stubGlobal('fetch', vi.fn());
    expect(await chat({ system: '', messages: [], connectionId: 'zzz' })).toEqual({ ok: false, error: expect.stringMatching(/no longer exists/) });
    expect(await chat({ system: '', messages: [], connectionId: 'a', connectionRevision: 1 })).toEqual({ ok: false, error: expect.stringMatching(/changed during this run/) });
  });

  it('retries once without parallel_tool_calls when the server rejects the field', async () => {
    seed([conn('a')], 'a');
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return bodies.length === 1
        ? new Response('{"error":{"message":"unknown field parallel_tool_calls"}}', { status: 400 })
        : sseResponse(toolCallStream);
    }));
    const tools = [{ name: 'browser', description: 'd', inputSchema: { type: 'object' } }];
    const result = await chat({ system: '', messages: [{ role: 'user', content: 'go' }], tools });
    expect(result.ok).toBe(true);
    expect(bodies[0]).toHaveProperty('parallel_tool_calls', false);
    expect(bodies[1]).not.toHaveProperty('parallel_tool_calls');
  });

  it('says Stopped when the caller aborts, and names a timeout as one', async () => {
    seed([conn('a')], 'a');
    // Like real fetch: reject at once on an already-aborted signal, else on abort.
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      if (init.signal?.aborted) reject(new DOMException('aborted', 'AbortError'));
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    const stop = new AbortController();
    const pending = chat({ system: '', messages: [] }, { signal: stop.signal });
    setTimeout(() => stop.abort(), 5);
    expect(await pending).toEqual({ ok: false, error: 'Stopped.' });
    expect(await chat({ system: '', messages: [], timeoutMs: 5 })).toEqual({ ok: false, error: 'Timed out waiting for the model.' });
  });

  it('declines providers without tool calling here', async () => {
    seed([conn('g', { kind: 'chatgpt' }), conn('n', { kind: 'chrome-builtin' })], 'g');
    expect((await chat({ system: '', messages: [] })).error).toMatch(/ChatGPT subscription is not available yet/);
    expect((await chat({ system: '', messages: [], connectionId: 'n' })).error).toMatch(/no tool calling/);
  });

  it('answers the ai-chat message op with the same result', async () => {
    seed([conn('a')], 'a');
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(toolCallStream)));
    const handle = createAiMessageHandler({ prefix: 't' });
    const answer = await new Promise((resolve) => handle({ type: 't:ai-chat', system: '', messages: [{ role: 'user', content: 'go' }] } as never, resolve));
    expect(answer).toMatchObject({ ok: true, toolCalls: [{ id: 'c1' }] });
  });
});

describe('the one writer for the connection record', () => {
  it('keeps every concurrent edit, across connections', async () => {
    seed([conn('a'), conn('b'), conn('c')], 'a');
    const handle = createAiMessageHandler({ prefix: 't' });
    const send = (message: Record<string, unknown>) => new Promise((resolve) => handle(message as never, resolve));
    const edit = (id: string, model: string) => send({ type: 't:ai-save-connection', id, kind: 'openai-compatible', label: id, baseUrl: 'http://localhost:11434', model, apiKeyMode: 'keep' });
    await Promise.all([edit('a', 'model-a'), edit('b', 'model-b'), edit('c', 'model-c'), send({ type: 't:ai-set-active', id: 'c' }), edit('a', 'model-a2')]);
    const stored = local.get(STORAGE_KEY) as { activeId: string; connections: Array<{ id: string; model: string; revision: number }> };
    expect(Object.fromEntries(stored.connections.map((c) => [c.id, c.model]))).toEqual({ a: 'model-a2', b: 'model-b', c: 'model-c' });
    expect(stored.connections.find((c) => c.id === 'a')!.revision).toBe(3);
    expect(stored.activeId).toBe('c');
  });
});
