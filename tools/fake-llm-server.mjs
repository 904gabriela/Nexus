// A real HTTP server speaking the OpenAI-compatible protocol.
//
// This is NOT a Playwright route mock: the browser opens a genuine TCP
// connection, gets real CORS preflight handling and a real SSE stream. It is
// the same shape of server as LM Studio or Ollama, so it exercises the whole
// transport path — including the cross-origin behaviour that decides whether a
// phone can reach a model running on a PC.
//
// The replies themselves are canned. This validates transport, streaming,
// persistence and error handling; it says nothing about model quality.
import { createServer } from 'node:http';

const PORT = Number(process.env.LLM_PORT ?? 8471);
const MODELS = ['local/storyteller-7b', 'local/storyteller-13b'];

let turn = 0;
/** The most recent request body, served at /_last for assertions. */
let lastRequest = null;
const REPLIES = [
  'The tavern door bangs open and the storm walks in with you. Sera looks up from the bar, eyes narrowing. "You picked a poor night for travelling," she says.',
  'She sets the cloth down slowly. "Ashfell," she repeats, as though the word costs her something. "Nobody goes there for pleasure."',
  'Sera pours two measures without asking. "Ask your question, traveller. The storm will keep."',
  'The fire gutters. Somewhere above, a shutter tears loose and slams against the wall.',
];

const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
};

const server = createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/_last') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(lastRequest ?? {}));
    return;
  }

  if (url.pathname.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: MODELS.map((id) => ({ id, object: 'model' })) }));
    return;
  }

  if (url.pathname.endsWith('/chat/completions')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* report below */ }
      // A short summary only. Writing the whole body here can fill the stdout
      // pipe when nothing is draining it, which blocks Node's event loop and
      // stalls the very stream we are trying to serve.
      lastRequest = parsed;
      process.stdout.write(
        `REQUEST model=${parsed.model} stream=${!!parsed.stream} ` +
        `messages=${(parsed.messages ?? []).length} ` +
        `auth=${req.headers.authorization ? 'present' : 'absent'}\n`,
      );

      const reply = REPLIES[Math.min(turn++, REPLIES.length - 1)];

      if (parsed.stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        // Genuine incremental delivery, a few words at a time.
        const chunks = reply.match(/\S+\s*/g) ?? [reply];
        let i = 0;
        const tick = setInterval(() => {
          if (i >= chunks.length) {
            clearInterval(tick);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: chunks[i] }, index: 0 }],
            })}\n\n`,
          );
          i += 1;
        }, 25);
        // res, not req: the request stream has already ended by this point, so
        // req's own 'close' can fire immediately and cancel the stream before a
        // single chunk is written.
        res.on('close', () => clearInterval(tick));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'cmpl-local',
        object: 'chat.completion',
        model: parsed.model ?? MODELS[0],
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      }));
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `No route for ${url.pathname}` } }));
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`local OpenAI-compatible server on http://127.0.0.1:${PORT}/v1\n`);
});
