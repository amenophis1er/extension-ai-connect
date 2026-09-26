import { createAiClient } from './lib/client.js';

const ai = createAiClient({ prefix: 'testhost' });
const $ = (id) => document.getElementById(id);

async function refresh() {
  const view = await ai.get();
  const box = $('connections');
  box.textContent = '';
  if (view.connections.length === 0) {
    box.textContent = 'No connections yet.';
    return;
  }
  for (const c of view.connections) {
    const row = document.createElement('div');
    row.className = 'row';
    const active = c.id === view.activeId ? ' ← active' : '';
    const text = document.createElement('span');
    text.textContent = `${c.label} — ${c.kind}/${c.auth} — model: ${c.model || '(none)'} — ${c.keyHint}${active}`;
    const use = document.createElement('button');
    use.textContent = 'Make active';
    use.onclick = async () => { await ai.setActive(c.id); await refresh(); };
    const del = document.createElement('button');
    del.textContent = 'Remove';
    del.onclick = async () => {
      await ai.deleteConnection(c.id);
      $('connect-status').textContent = '';
      $('out').textContent = '';
      await refresh();
    };
    row.append(text, use, del);
    box.append(row);
  }
}

async function activeConnection() {
  const view = await ai.get();
  return view.connections.find((c) => c.id === view.activeId);
}

$('connect').onclick = async () => {
  const status = $('connect-status');
  status.textContent = 'Opening ollama.com…';
  const start = await ai.ollamaLoginStart($('device').value);
  if (!start.ok) { status.textContent = `Error: ${start.error}`; return; }
  $('connect-link').textContent = `If no tab opened: ${start.data.connectUrl}`;
  status.textContent = 'Waiting for you to click Connect on ollama.com…';
  for (;;) {
    await new Promise((r) => setTimeout(r, start.data.pollMs));
    const poll = await ai.ollamaLoginPoll('');
    if (!poll.ok) { status.textContent = `Error: ${poll.error}`; return; }
    if (poll.data.status === 'created') {
      status.textContent = 'Connected. Load models below and pick one.';
      $('connect-link').textContent = '';
      await refresh();
      return;
    }
  }
};

$('models').onclick = async () => {
  const conn = await activeConnection();
  if (!conn) { $('out').textContent = 'No active connection.'; return; }
  const res = await ai.listModels({ kind: conn.kind, baseUrl: conn.baseUrl, apiKey: '', id: conn.id });
  if (!res.ok) { $('out').textContent = `Error: ${res.error}`; return; }
  $('model').textContent = '';
  for (const m of res.data) $('model').append(new Option(m.name, m.id, false, m.id === conn.model));
  $('out').textContent = `${res.data.length} models.`;
};

$('save-model').onclick = async () => {
  const conn = await activeConnection();
  if (!conn) return;
  await ai.saveConnection({ id: conn.id, kind: conn.kind, label: conn.label, baseUrl: conn.baseUrl,
    model: $('model').value, apiKeyMode: 'keep', makeActive: true });
  await refresh();
};

$('run').onclick = async () => {
  $('out').textContent = 'Running…';
  const res = await ai.complete({ system: 'You are a terse assistant.', prompt: $('prompt').value, maxTokens: 400 });
  $('out').textContent = res.ok ? res.data : `Error: ${res.error}`;
};

void refresh();
