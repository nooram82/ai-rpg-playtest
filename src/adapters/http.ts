import type { GameFactory, SessionContext } from './types.js';

/**
 * A game behind an HTTP API. Bodies, URLs and headers are templates:
 *   {{action}}    the player's action
 *   {{sessionId}} the harness's id for this playthrough
 *   {{session}}   the session value your start call returned (see `session` below)
 *   {{character}} the persona's one-line character description
 *   {{env.NAME}}  an environment variable, for tokens
 */
export interface HttpRequestSpec {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /**
   * Where the player-facing text is in the JSON response, as a dot path ("reply.text",
   * "messages[-1].content", "events[*].text"). A path ending in an array joins its strings.
   * "$text" uses the raw response body.
   */
  reply?: string;
  /** start only: where your game's session id is in the response, for {{session}} in later calls. */
  session?: string;
}

export interface HttpGameConfig {
  type: 'http';
  start?: HttpRequestSpec;
  act: HttpRequestSpec;
  /** Default 300000 (5 minutes); AI turns can be slow. */
  timeoutMs?: number;
}

export function httpGame(cfg: HttpGameConfig): GameFactory {
  return async (ctx) => {
    let session = '';
    const call = async (spec: HttpRequestSpec, action: string) => {
      const vars = { action, sessionId: ctx.sessionId, session, character: ctx.character };
      const res = await fetch(fill(spec.url, vars), {
        method: spec.method ?? 'POST',
        headers: { 'content-type': 'application/json', ...fillDeep(spec.headers ?? {}, vars) },
        body: spec.body === undefined || (spec.method ?? 'POST') === 'GET' ? undefined : JSON.stringify(fillDeep(spec.body, vars)),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 300_000),
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(`Game returned ${res.status}: ${raw.slice(0, 300)}`);
      return raw;
    };
    return {
      start: async () => {
        if (!cfg.start) return '';
        const raw = await call(cfg.start, '');
        if (cfg.start.session) session = String(pick(JSON.parse(raw), cfg.start.session) ?? '');
        return cfg.start.reply ? extract(raw, cfg.start.reply) : '';
      },
      act: async (action) => extract(await call(cfg.act, action), cfg.act.reply ?? '$text'),
    };
  };
}

type Vars = Pick<SessionContext, 'sessionId' | 'character'> & { action: string; session: string };

export function fill(template: string, vars: Vars): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    if (key.startsWith('env.')) return process.env[key.slice(4)] ?? '';
    const v = (vars as unknown as Record<string, string>)[key];
    return v ?? '';
  });
}

export function fillDeep<T>(value: T, vars: Vars): T {
  if (typeof value === 'string') return fill(value, vars) as T;
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, vars)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, vars)])) as T;
  }
  return value;
}

export function extract(raw: string, path: string): string {
  if (path === '$text') return raw.trim();
  const v = pick(JSON.parse(raw), path);
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim()).join('\n\n');
  if (v === undefined || v === null) throw new Error(`Nothing at "${path}" in the game's response: ${raw.slice(0, 300)}`);
  return String(v);
}

/** Dot path with [n], [-n] and [*] (map over an array). */
export function pick(obj: unknown, path: string): unknown {
  const parts = path.match(/[^.[\]]+|\[-?\d+\]|\[\*\]/g) ?? [];
  let cur: unknown = obj;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (cur === undefined || cur === null) return undefined;
    if (p === '[*]') {
      if (!Array.isArray(cur)) return undefined;
      const rest = parts.slice(i + 1).join('.').replace(/\.\[/g, '[');
      return rest ? cur.map((x) => pick(x, rest)).flat() : cur;
    }
    const idx = p.match(/^\[(-?\d+)\]$/);
    if (idx) {
      if (!Array.isArray(cur)) return undefined;
      const n = Number(idx[1]);
      cur = cur[n < 0 ? cur.length + n : n];
    } else {
      cur = (cur as Record<string, unknown>)[p];
    }
  }
  return cur;
}
