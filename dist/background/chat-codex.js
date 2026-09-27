/**
 * `chat()` for the ChatGPT subscription: OpenAI's Codex backend
 * (`chatgpt.com/backend-api/codex/responses`, the Responses API) with the
 * account's own sign-in, streamed, with function tools.
 *
 * Request: `instructions` is the system prompt; the history becomes Responses
 * input items — messages, and tool calls and results as top-level
 * `function_call` / `function_call_output` items. Tool results carry text
 * only, so their images follow as one user message.
 *
 * Backend quirks:
 *  - `max_output_tokens` is refused, so no output cap is sent;
 *  - `store: false`, and no encrypted reasoning is asked for: with nothing
 *    to replay it into, asking makes tool continuations fail;
 *  - the answer always streams.
 *
 * Provider error text is never copied into an error: it can echo the request.
 */
export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
function userParts(content) {
    if (typeof content === 'string')
        return [{ type: 'input_text', text: content }];
    return content.map((part) => {
        if (part.type === 'text')
            return { type: 'input_text', text: part.text };
        if (part.type === 'image')
            return { type: 'input_image', image_url: `data:${part.mediaType};base64,${part.data}` };
        return { type: 'input_file', filename: part.name ?? 'document.pdf', file_data: `data:${part.mediaType};base64,${part.data}` };
    });
}
/** The history as Responses input items. */
export function codexInput(messages) {
    const items = [];
    // Images and documents from tool results, sent as one user message after them.
    let pending = [];
    const flush = () => {
        if (pending.length === 0)
            return;
        items.push({ type: 'message', role: 'user', content: userParts(pending) });
        pending = [];
    };
    for (const message of messages) {
        if (message.role === 'tool') {
            const text = typeof message.content === 'string' ? message.content
                : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
            items.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.isError ? `Error: ${text}` : text });
            if (typeof message.content !== 'string')
                pending.push(...message.content.filter((part) => part.type !== 'text'));
            continue;
        }
        flush();
        if (message.role === 'user') {
            items.push({ type: 'message', role: 'user', content: userParts(message.content) });
            continue;
        }
        if (message.content)
            items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
        for (const call of message.toolCalls ?? []) {
            items.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.argsError ? call.argsError.raw : JSON.stringify(call.args ?? {}) });
        }
    }
    flush();
    return items;
}
export function codexBody(req, model) {
    return {
        model, store: false, stream: true,
        instructions: req.system || 'You are a helpful assistant.',
        input: codexInput(req.messages),
        ...(req.tools?.length ? {
            tools: req.tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false })),
            tool_choice: 'auto',
            parallel_tool_calls: req.parallelToolCalls === true,
        } : {}),
    };
}
/** An HTTP failure in words, without the provider's own text. */
export function codexHttpError(status, body) {
    let code = '';
    let message = '';
    try {
        const data = JSON.parse(body);
        const error = (data['error'] ?? data['detail'] ?? {});
        const c = error['code'] ?? error['type'] ?? data['code'];
        code = typeof c === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(c) ? c : '';
        const m = error['message'] ?? data['detail'] ?? data['message'];
        message = typeof m === 'string' ? m : '';
    }
    catch { /* the status is enough */ }
    if (/model.{0,200}(not supported|unsupported|not available|does not exist)/i.test(message) && (status === 400 || status === 404)) {
        return 'That model is not available for this ChatGPT account. Pick another model in Settings.';
    }
    if (status === 401 || /invalid_api_key|token_expired|unauthorized/i.test(code))
        return 'ChatGPT rejected this sign-in. Sign in again in Settings.';
    if (status === 429 || /usage_limit|rate_limit/i.test(code))
        return 'Your ChatGPT plan’s limit is reached. Wait for it to reset.';
    if (/context_length|context_window/i.test(code))
        return 'The conversation is longer than this model accepts.';
    if (status >= 500)
        return `ChatGPT’s backend failed (HTTP ${status}).`;
    return `ChatGPT refused the request (HTTP ${status}${code ? `; ${code}` : ''}).`;
}
/**
 * The Responses stream, assembled into one turn. The result counts only once
 * `response.completed` (or `response.incomplete`) has arrived; `error` and
 * `response.failed` are failures, and so is a stream that ends before either.
 */
export async function codexResult(events) {
    const texts = new Map();
    const calls = new Map();
    let completed = false;
    let incomplete = false;
    let usage;
    const call = (item) => {
        const id = typeof item['id'] === 'string' ? item['id'] : String(item['call_id'] ?? '');
        let entry = calls.get(id);
        if (!entry) {
            entry = { callId: typeof item['call_id'] === 'string' ? item['call_id'] : id, name: typeof item['name'] === 'string' ? item['name'] : '', args: '', gotDelta: false };
            calls.set(id, entry);
        }
        return entry;
    };
    for await (const { data } of events) {
        if (data.trim() === '[DONE]')
            break;
        let event;
        try {
            event = JSON.parse(data);
        }
        catch {
            return { ok: false, error: 'Malformed stream chunk.' };
        }
        const itemId = typeof event['item_id'] === 'string' ? event['item_id'] : '';
        switch (event['type']) {
            case 'response.output_item.added':
                if (event['item']?.type === 'function_call')
                    call(event['item']);
                break;
            case 'response.output_text.delta':
                if (typeof event['delta'] === 'string')
                    texts.set(itemId, (texts.get(itemId) ?? '') + event['delta']);
                break;
            case 'response.function_call_arguments.delta': {
                const entry = calls.get(itemId);
                if (entry && typeof event['delta'] === 'string') {
                    entry.args += event['delta'];
                    entry.gotDelta = true;
                }
                break;
            }
            case 'response.output_item.done': {
                const item = event['item'] ?? {};
                if (item.type !== 'function_call')
                    break;
                const entry = call(item);
                if (!entry.gotDelta && typeof item.arguments === 'string')
                    entry.args = item.arguments;
                if (!entry.name && typeof item.name === 'string')
                    entry.name = item.name;
                break;
            }
            case 'response.completed':
            case 'response.incomplete': {
                const response = event['response'] ?? {};
                const u = response.usage ?? {};
                if (typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number')
                    usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
                incomplete = event['type'] === 'response.incomplete' || response.status === 'incomplete';
                completed = true;
                break;
            }
            case 'response.failed':
                return { ok: false, error: codexHttpError(0, JSON.stringify(event['response'] ?? {})).replace(' (HTTP 0)', '') };
            case 'error':
                return { ok: false, error: codexHttpError(0, JSON.stringify({ error: event['error'] ?? event })).replace(' (HTTP 0)', '') };
            default:
        }
    }
    if (!completed)
        return { ok: false, error: 'The response stream ended before it finished.' };
    const toolCalls = [...calls.values()].map((entry) => {
        const out = { id: entry.callId, name: entry.name };
        try {
            const parsed = entry.args.trim() === '' ? {} : JSON.parse(entry.args);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                out.args = parsed;
            else
                out.argsError = { raw: entry.args, message: 'Tool arguments are not a JSON object.' };
        }
        catch (error) {
            out.argsError = { raw: entry.args, message: error instanceof Error ? error.message : 'Invalid JSON.' };
        }
        return out;
    });
    const text = [...texts.values()].join('\n\n').trim();
    // A turn cut off by the limit may carry a truncated call: never hand one out.
    if (incomplete)
        return { ok: true, ...(text ? { text } : {}), stopReason: 'length', ...(usage ? { usage } : {}) };
    return {
        ok: true,
        ...(text ? { text } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        stopReason: toolCalls.length > 0 ? 'tool_use' : 'end',
        ...(usage ? { usage } : {}),
    };
}
