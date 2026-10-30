// A module adapter: use this when your game needs glue the http adapter can't express
// (sign-in, streaming replies, websockets, or calling your engine in-process).
//
// Config:  "game": { "type": "module", "path": "./module-game.mjs", "options": { "baseUrl": "http://localhost:3000" } }

export async function createGame(options, ctx) {
  const base = options.baseUrl;
  let token;
  let gameId;

  return {
    async start() {
      // Sign in a throwaway test player for this playthrough.
      const auth = await fetch(`${base}/api/test-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user: ctx.sessionId }),
      }).then((r) => r.json());
      token = auth.token;

      const game = await post('/api/games', { character: ctx.character });
      gameId = game.id;
      return game.opening ?? '';
    },

    async act(action) {
      // A streamed reply: read the whole stream, keep the text events.
      const res = await fetch(`${base}/api/games/${gameId}/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: action }),
      });
      const raw = await res.text();
      return raw
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)))
        .filter((event) => event.type === 'narration' || event.type === 'dialogue')
        .map((event) => event.text)
        .join('\n\n');
    },

    async close() {
      await post(`/api/games/${gameId}/delete`, {});
    },
  };

  async function post(path, body) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res.json();
  }
}
