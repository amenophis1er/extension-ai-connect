# Recorded fixtures

- `openai-ollama-toolcall.sse` — ollama.com `/v1/chat/completions`, model
  `gpt-oss:20b`, streamed, one tool (`browser`), `parallel_tool_calls: false`,
  recorded 2026-09-26 with a device-key-signed request. Reasoning arrives in
  `delta.reasoning`; the tool call arrives whole in one chunk; the model chose
  an action outside the schema's enum (validation is the caller's job).
- `openai-ollama-glm-toolcall.sse` — same request, model `glm-5.3-flash`,
  `parallel_tool_calls` omitted.
