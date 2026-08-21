// A real HTTP server shaped like Ollama.
//
// Ollama's native API and its OpenAI-compatible surface are both served, so the
// client can be exercised against either. The point of this server is the CORS
// switch: with CORS=off it behaves like a default Ollama install, which answers
// a browser's top-level navigation happily but sends no
// Access-Control-Allow-Origin, so a cross-origin fetch from a page is blocked.
// That is the difference between "Safari can open the URL" and "the app can
// fetch it", and it is the case this server exists to reproduce.
import { createServer } from 'node:http';

const PORT = Number(process.env.OLLAMA_PORT ?? 11434);
/** 'on' allows any origin; 'off' mimics a default install; 'local' allows only loopback origins. */
const CORS = process.env.CORS ?? 'on';

const MODELS = [
  {
    name: 'llama3.1:latest',
    model: 'llama3.1:latest',
    size: 4920753328,
    details: {
      family: 'llama',
      parameter_size: '8.0B',
      quantization_level: 'Q4_K_M',
    },
  },
];

const REPLY =
  'The fire has burned low. Sera sets down the cloth she was folding and looks at you properly for the first time all evening.';

function corsHeaders(origin) {
  if (CORS === 'off') return {};
  if (CORS === 'local') {
    const ok = origin && /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(origin);
    if (!ok) return {};
  }
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = corsHeaders(origin);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, ...cors });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(CORS === 'off' ? 403 : 204, cors);
    res.end();
    return;
  }

  // Ollama's root, exactly as a browser navigation sees it.
  if (url.pathname === '/') return send(200, 'Ollama is running', 'text/plain');

  if (url.pathname === '/api/tags') return send(200, { models: MODELS });

  if (url.pathname === '/v1/models') {
    return send(200, {
      object: 'list',
      data: MODELS.map((m) => ({ id: m.name, object: 'model' })),
    });
  }

  // Native Ollama chat: newline-delimited JSON, not SSE.
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    const body = await readBody(req);
    if (body?.stream === false) {
      return send(200, {
        model: body.model,
        message: { role: 'assistant', content: REPLY },
        done: true,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', ...cors });
    for (const chunk of REPLY.match(/.{1,14}/gs) ?? [REPLY]) {
      res.write(`${JSON.stringify({
        model: body?.model,
        message: { role: 'assistant', content: chunk },
        done: false,
      })}\n`);
      await new Promise((r) => setTimeout(r, 12));
    }
    res.write(`${JSON.stringify({ model: body?.model, done: true })}\n`);
    res.end();
    return;
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body?.stream) {
      return send(200, { choices: [{ message: { role: 'assistant', content: REPLY } }] });
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', ...cors });
    for (const chunk of REPLY.match(/.{1,14}/gs) ?? [REPLY]) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
      await new Promise((r) => setTimeout(r, 12));
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  send(404, { error: 'not found' });
});

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`fake-ollama on :${PORT} (CORS=${CORS})`);
});
