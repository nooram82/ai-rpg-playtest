import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Model clients. "openai" (the default) is any OpenAI-compatible chat endpoint: OpenAI,
 * OpenRouter, Together, Groq, a local Ollama or LM Studio, vLLM. No SDK, just fetch.
 * "claude-code" runs `claude -p` with no tools, on whatever account Claude Code is signed in
 * with, and "codex" runs `codex exec` the same way on the Codex sign-in, so a developer who has
 * either needs no API key at all.
 */

export interface ModelConfig {
  /** Default "openai". */
  provider?: 'openai' | 'claude-code' | 'codex';
  /** e.g. https://api.openai.com/v1, https://openrouter.ai/api/v1, http://localhost:11434/v1. Not used by claude-code or codex. */
  baseUrl?: string;
  /** The model id as the endpoint names it. For claude-code: haiku, sonnet, opus or a full id. For codex: a model id, or "default" for the one in your Codex config. */
  model: string;
  /** Name of the environment variable holding the API key. Omit for local servers. */
  apiKeyEnv?: string;
  temperature?: number;
  maxTokens?: number;
  /** Send response_format json_object. Only some providers accept it; parsing is lenient either way. */
  jsonMode?: boolean;
  /** Extra fields merged into the request body (provider routing, reasoning settings...). */
  extraBody?: Record<string, unknown>;
  /** Per request. Default 180000 (3 minutes); a stalled request is retried. */
  timeoutMs?: number;
  /** claude-code and codex: reasoning effort (low, medium, high...). Lower is faster. */
  effort?: string;
  /** claude-code and codex: the CLI to run. Default "claude" or "codex". */
  command?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatModel {
  chat(messages: ChatMessage[], opts?: { json?: boolean; temperature?: number }): Promise<string>;
}

export function makeModel(cfg: ModelConfig): ChatModel {
  if (cfg.provider === 'claude-code') return new ClaudeCodeModel(cfg);
  if (cfg.provider === 'codex') return new CodexModel(cfg);
  return new HttpChatModel(cfg);
}

export class HttpChatModel implements ChatModel {
  constructor(private cfg: ModelConfig, private retries = 4) {}

  async chat(messages: ChatMessage[], opts: { json?: boolean; temperature?: number } = {}): Promise<string> {
    const key = this.cfg.apiKeyEnv ? process.env[this.cfg.apiKeyEnv] : undefined;
    if (this.cfg.apiKeyEnv && !key) throw new Error(`Environment variable ${this.cfg.apiKeyEnv} is not set`);
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      temperature: opts.temperature ?? this.cfg.temperature ?? 0.8,
      ...(this.cfg.maxTokens ? { max_tokens: this.cfg.maxTokens } : {}),
      ...(opts.json && this.cfg.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      ...(this.cfg.extraBody ?? {}),
    };
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(Math.min(30_000, 1000 * 2 ** attempt));
      try {
        const res = await fetch(`${(this.cfg.baseUrl ?? '').replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 180_000),
        });
        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
          continue;
        }
        if (!res.ok) throw new Error(`Model call failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = data.choices?.[0]?.message?.content;
        // Reasoning models sometimes spend the whole budget thinking and return nothing.
        if (!content || !content.trim()) {
          lastError = new Error('Empty reply from model');
          continue;
        }
        return content;
      } catch (err) {
        lastError = err;
        if (err instanceof Error && err.message.startsWith('Model call failed')) throw err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

/**
 * One `claude -p` process per call: no tools, no session saved, customizations off, run from the
 * temp folder so the project's CLAUDE.md never reaches the player or judge. Temperature and
 * max tokens are not settable here.
 */
export class ClaudeCodeModel implements ChatModel {
  constructor(private cfg: ModelConfig, private retries = 2) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const { system, prompt } = flatten(messages);
    const args = ['-p', '--model', this.cfg.model, '--tools', '', '--output-format', 'json', '--no-session-persistence', '--safe-mode'];
    if (system) args.push('--system-prompt', system);
    if (this.cfg.effort) args.push('--effort', this.cfg.effort);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(2000 * 2 ** attempt);
      try {
        const out = await runCli(this.cfg.command ?? 'claude', args, prompt, this.cfg.timeoutMs ?? 180_000);
        const data = parseJsonLoose(out) as { result?: string; is_error?: boolean } | undefined;
        if (!data) throw new Error(`claude returned no JSON: ${out.slice(0, 300)}`);
        if (data.is_error) throw new Error(`claude: ${String(data.result ?? 'error').slice(0, 300)}`);
        if (!data.result?.trim()) throw new Error('Empty reply from claude');
        return data.result;
      } catch (err) {
        lastError = err;
        if (err instanceof Error && /ENOENT/.test(err.message)) throw new Error(`Could not run "${this.cfg.command ?? 'claude'}". Is Claude Code installed and on PATH?`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

/**
 * One `codex exec` per call: read-only sandbox, nothing saved, run from the temp folder so no
 * AGENTS.md is read. Codex has no system prompt flag, so the system text leads the prompt.
 */
export class CodexModel implements ChatModel {
  constructor(private cfg: ModelConfig, private retries = 2) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const { system, prompt } = flatten(messages);
    const full = `${system ? `INSTRUCTIONS\n${system}\n\n` : ''}Answer from this message alone. Do not run commands, read files or use tools.\n\n${prompt}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpg-playtest-codex-'));
    const last = path.join(dir, 'last.txt');
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-o', last];
    if (this.cfg.model && this.cfg.model !== 'default') args.push('-m', this.cfg.model);
    if (this.cfg.effort) args.push('-c', `model_reasoning_effort="${this.cfg.effort}"`);
    args.push('-');
    let lastError: unknown;
    try {
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        if (attempt > 0) await sleep(2000 * 2 ** attempt);
        try {
          fs.rmSync(last, { force: true });
          await runCli(this.cfg.command ?? 'codex', args, full, this.cfg.timeoutMs ?? 180_000, { requireStdout: false });
          const text = fs.existsSync(last) ? fs.readFileSync(last, 'utf8') : '';
          if (!text.trim()) throw new Error('Empty reply from codex');
          return text;
        } catch (err) {
          lastError = err;
          if (err instanceof Error && /ENOENT/.test(err.message)) throw new Error(`Could not run "${this.cfg.command ?? 'codex'}". Is the Codex CLI installed and on PATH?`);
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

/** The CLIs take one prompt, so a multi-message chat (the chat game adapter) becomes a transcript. */
function flatten(messages: ChatMessage[]): { system: string; prompt: string } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system');
  const prompt =
    turns.length === 1
      ? turns[0].content
      : `${turns
          .slice(0, -1)
          .map((m) => `[${m.role === 'user' ? 'Player' : 'You'}]\n${m.content}`)
          .join('\n\n')}\n\n[Player]\n${turns[turns.length - 1].content}\n\nWrite your next reply only, without a label.`;
  return { system, prompt };
}

function runCli(command: string, args: string[], stdin: string, timeoutMs: number, opts: { requireStdout?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // A failed claude call still prints its JSON result with is_error, so try stdout first.
      if (opts.requireStdout === false ? code === 0 : out.trim()) resolve(out);
      else reject(new Error(`${command} exited ${code}: ${(err || out).slice(-300)}`));
    });
    child.stdin.end(stdin);
  });
}

/** Ask for JSON and parse it, tolerating code fences and prose around the object. Retries on bad JSON. */
export async function chatJson<T>(model: ChatModel, messages: ChatMessage[], opts: { temperature?: number; tries?: number } = {}): Promise<T> {
  const tries = opts.tries ?? 3;
  let last = '';
  for (let i = 0; i < tries; i++) {
    last = await model.chat(messages, { json: true, temperature: opts.temperature });
    const parsed = parseJsonLoose(last);
    if (parsed !== undefined) return parsed as T;
  }
  throw new Error(`Model did not return JSON after ${tries} tries. Last reply: ${last.slice(0, 300)}`);
}

export function parseJsonLoose(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
