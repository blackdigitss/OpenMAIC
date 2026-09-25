/**
 * Local OpenAI-compatible endpoint backed by your Claude subscription, so OpenMAIC's
 * lesson generation (which only speaks to API providers) runs on Claude with no
 * change to OpenMAIC itself: its "openai" provider is pointed here
 * (OPENAI_BASE_URL=http://127.0.0.1:3002/v1) and models are claude-opus,
 * claude-sonnet, claude-haiku.
 *
 * - Loopback only, and requests must carry the bridge token (OPENAI_API_KEY).
 * - Chat completions without tools: text, or JSON when a response_format asks for it.
 *   Streaming requests get the finished answer as one chunk.
 * - A Claude usage limit is answered with 429 so callers can fall back to Gemini.
 * - At most two Claude runs at a time; the rest wait their turn.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { homedir } from 'os';
import { join } from 'path';

import { loadEnv } from './env';

loadEnv();

const PORT = Number(process.env.SENSEI_BRIDGE_PORT ?? 3002);
const TOKEN = process.env.OPENAI_API_KEY ?? '';
const BIN = process.env.SENSEI_CLAUDE_BIN || join(homedir(), '.local', 'bin', 'claude');
const MODELS: Record<string, string> = { 'claude-opus': 'opus', 'claude-sonnet': 'sonnet', 'claude-haiku': 'haiku' };
const MAX_PARALLEL = 2;

type Part = { type: string; text?: string };
interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | Part[] | null;
}
interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: unknown[];
  response_format?: { type: string; json_schema?: { schema?: object } };
}

let briefText: (() => Promise<string>) | null = null;
async function senseiBrief(): Promise<string> {
  if (!briefText) {
    const { senseiDb } = await import('@/lib/sensei/db/pool');
    const { briefProvider } = await import('@/lib/sensei/brief');
    briefText = briefProvider(await senseiDb());
  }
  return briefText().catch(async () => (await import('@/lib/sensei/brief')).SENSEI_BRIEF);
}

let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

const textOf = (c: ChatMessage['content']) => (typeof c === 'string' ? c : (c ?? []).map((p) => p.text ?? '').join('\n'));

/** OpenAI messages → one system prompt and one prompt (earlier turns rendered as a transcript). */
export function toPrompt(messages: ChatMessage[]): { system: string; prompt: string } {
  const system = messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => textOf(m.content)).join('\n\n');
  const turns = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (turns.length === 1) return { system, prompt: textOf(turns[0].content) };
  const history = turns
    .slice(0, -1)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${textOf(m.content)}`)
    .join('\n\n');
  return { system, prompt: `<conversation>\n${history}\n</conversation>\n\n${textOf(turns[turns.length - 1].content)}` };
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: { message: 'Bad bridge token' } });
  const url = (req.url ?? '').replace(/\/+$/, '');
  if (req.method === 'GET' && url.endsWith('/models')) {
    return send(res, 200, { object: 'list', data: Object.keys(MODELS).map((id) => ({ id, object: 'model', owned_by: 'claude-subscription' })) });
  }
  if (req.method !== 'POST' || !url.endsWith('/chat/completions')) return send(res, 404, { error: { message: 'Not found' } });
  const body = JSON.parse(await readBody(req)) as ChatRequest;
  if (body.tools?.length) return send(res, 400, { error: { message: 'The Claude bridge does not support tool calls' } });
  const parts = toPrompt(body.messages ?? []);
  // Lessons follow the same standing brief as the rest of Sensei (course, sources, rules).
  const system = `${await senseiBrief()}\n\n---\n\nYour task:\n${parts.system}`;
  const prompt = parts.prompt;
  const wantsJson = body.response_format?.type === 'json_schema' || body.response_format?.type === 'json_object';
  const schema = body.response_format?.json_schema?.schema;
  const { claudeCliComplete } = await import('@/lib/sensei/llm');
  let out;
  try {
    out = await slot(() =>
      claudeCliComplete(BIN, {
        model: MODELS[body.model] ?? body.model,
        system: wantsJson && !schema ? `${system}\n\nRespond with a single JSON value only.` : system,
        prompt,
        jsonSchema: schema,
      }),
    );
  } catch (e) {
    const err = e as { statusCode?: number; message?: string };
    return send(res, err.statusCode === 429 ? 429 : 502, { error: { message: err.message ?? 'Claude failed', type: err.statusCode === 429 ? 'insufficient_quota' : 'server_error' } });
  }
  const content = schema && out.structured !== undefined ? JSON.stringify(out.structured) : out.text;
  const id = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const usage = { prompt_tokens: out.usage.inputTokens, completion_tokens: out.usage.outputTokens, total_tokens: out.usage.inputTokens + out.usage.outputTokens };
  if (!body.stream) {
    return send(res, 200, { id, object: 'chat.completion', created, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage });
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const chunk = (delta: object, finish: string | null, extra: object = {}) =>
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
  chunk({ role: 'assistant', content: '' }, null);
  chunk({ content }, null);
  chunk({}, 'stop', { usage });
  res.end('data: [DONE]\n\n');
}

if (process.argv[1]?.endsWith('claude-bridge.ts')) {
  createServer((req, res) => {
    handle(req, res).catch((e) => send(res, 500, { error: { message: (e as Error).message } }));
  }).listen(PORT, '127.0.0.1', () => console.log(`[${new Date().toISOString()}] Claude bridge on 127.0.0.1:${PORT}`));
}
