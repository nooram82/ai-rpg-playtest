import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { NARRATOR } from './prompt.mjs';

const PORT = Number(process.env.PORT ?? 4317);
const HISTORY_WINDOW = 4; // messages sent to the model each turn
const games = new Map();

function narrate(history) {
  const recent = history.slice(-HISTORY_WINDOW);
  const prompt = recent.map((m) => `${m.role === 'player' ? 'PLAYER' : 'NARRATOR'}: ${m.text}`).join('\n\n') + '\n\nNARRATOR:';
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--model', 'haiku', '--tools', '', '--no-session-persistence', '--safe-mode', '--system-prompt', NARRATOR], { cwd: os.tmpdir() });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 && out.trim() ? resolve(out.trim()) : reject(new Error(`narrator exited ${code}`))));
    child.stdin.end(prompt);
  });
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

http
  .createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.method === 'POST' && req.url === '/games') {
        const { player } = await body(req);
        const id = randomUUID();
        const history = [{ role: 'player', text: `I arrive in Lowmere. ${player ? `(${player})` : ''}` }];
        const opening = await narrate(history);
        history.push({ role: 'narrator', text: opening });
        games.set(id, history);
        return send(200, { id, opening });
      }
      const m = req.url?.match(/^\/games\/([\w-]+)\/turn$/);
      if (req.method === 'POST' && m) {
        const history = games.get(m[1]);
        if (!history) return send(404, { error: 'no such game' });
        const { text } = await body(req);
        history.push({ role: 'player', text });
        const narration = await narrate(history);
        history.push({ role: 'narrator', text: narration });
        return send(200, { narration });
      }
      send(404, { error: 'not found' });
    } catch (err) {
      send(500, { error: String(err) });
    }
  })
  .listen(PORT, () => console.log(`Lowmere on http://localhost:${PORT}`));
