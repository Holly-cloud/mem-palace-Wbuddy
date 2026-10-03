'use strict';
/**
 * 内置 LLM 能力。
 *
 * 三种后端：
 *   ollama    — 本地模型，默认 http://127.0.0.1:11434，开箱即用且无需密钥
 *   openai    — 任意 OpenAI 兼容端点（云端或本地 vLLM/LM Studio）
 *   anthropic — Claude Messages API
 *
 * 关键设计：批量抽取会产生大量并发请求，所以必须有
 *   1) 指数退避重试（含 429 限流）
 *   2) 并发池，避免打爆本地推理服务
 *   3) JSON 容错解析 —— LLM 总会偶尔在 JSON 外面加话或用 markdown 包裹
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT = 120000;

function httpRequest(urlStr, { method = 'POST', headers = {}, body = null, timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (err) {
      return reject(new Error(`无效 URL: ${urlStr}`));
    }
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body == null ? null : Buffer.from(body);

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          ...(payload ? { 'Content-Length': payload.length } : {}),
          ...headers,
        },
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, text, headers: res.headers });
          } else {
            const err = new Error(`HTTP ${res.statusCode}: ${text.slice(0, 400)}`);
            err.status = res.statusCode;
            err.body = text;
            reject(err);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`请求超时 (${timeout}ms)`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryable(err) {
  if (!err) return false;
  if (err.status === 429) return true;
  if (err.status && err.status >= 500) return true;
  const msg = String(err.message || '');
  return /timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|network/i.test(msg);
}

async function withRetry(fn, { retries = 3, baseDelay = 800, onRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetryable(err)) break;
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 400;
      if (onRetry) onRetry(attempt + 1, delay, err);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// --- JSON 容错解析 ------------------------------------------------------

/**
 * 从 LLM 输出里提取 JSON。
 * 依次尝试：直接解析 → 去 markdown 围栏 → 找最外层数组/对象 → 括号配平扫描。
 */
function parseLooseJSON(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();

  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(s);
  if (fence) s = fence[1].trim();

  try { return JSON.parse(s); } catch (_) {}

  // 扫描配平的括号。必须按「最早出现的括号」顺序尝试，
  // 否则像 `[...]` 里嵌套 `{...}` 的情况会被先扫 `{` 而漏掉外层数组。
  const candidates = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{' || s[i] === '[') {
      candidates.push(i);
      if (candidates.length >= 4) break; // 最多试 4 个起点，够覆盖解释文字场景
    }
  }

  for (const start of candidates) {
    const open = s[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(s.slice(start, i + 1));
            // 优先返回数组（更符合抽取结果的形态）
            if (Array.isArray(parsed)) return parsed;
            if (parsed && Array.isArray(parsed.cards)) return parsed;
          } catch (_) { /* 试下一个起点 */ }
          break;
        }
      }
    }
  }
  return null;
}

// --- 客户端 -------------------------------------------------------------

class LLMClient {
  constructor(config = {}) {
    this.provider = config.provider || 'ollama';
    this.baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
    this.model = config.model || '';
    this.apiKey = config.apiKey || '';
    this.temperature = config.temperature ?? 0.1;
    this.maxTokens = config.maxTokens || 4096;
    this.concurrency = Math.max(1, Math.min(8, config.concurrency || 2));
    this.timeout = config.timeout || DEFAULT_TIMEOUT;
  }

  describe() {
    return { provider: this.provider, baseUrl: this.baseUrl, model: this.model };
  }

  /**
   * 探测可用模型。Ollama 无需密钥，最可能开箱可用，故优先探测。
   */
  static async detect(config = {}) {
    const results = [];

    // --- Ollama ---
    const ollamaUrl = (config.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    try {
      const res = await httpRequest(`${ollamaUrl}/api/tags`, { method: 'GET', timeout: 4000 });
      const data = JSON.parse(res.text);
      const models = (data.models || [])
        .map((m) => ({
          id: m.name,
          size: m.size,
          family: (m.details && m.details.family) || '',
        }))
        .sort((a, b) => (b.size || 0) - (a.size || 0));
      results.push({
        provider: 'ollama',
        available: true,
        baseUrl: ollamaUrl,
        models,
        note: `本地推理，无需密钥。已发现 ${models.length} 个模型。`,
      });
    } catch (err) {
      results.push({
        provider: 'ollama',
        available: false,
        baseUrl: ollamaUrl,
        models: [],
        note: `未检测到 Ollama（${err.message}）。若已安装请确认服务已启动。`,
      });
    }

    // --- OpenAI 兼容端点 ---
    const openaiUrl = (config.openaiBaseUrl || '').replace(/\/+$/, '');
    if (openaiUrl && config.openaiKey) {
      try {
        const res = await httpRequest(`${openaiUrl}/models`, {
          method: 'GET',
          timeout: 6000,
          headers: { Authorization: `Bearer ${config.openaiKey}` },
        });
        const data = JSON.parse(res.text);
        const models = (data.data || []).map((m) => ({ id: m.id })).slice(0, 40);
        results.push({
          provider: 'openai',
          available: true,
          baseUrl: openaiUrl,
          models,
          note: `已连接，发现 ${models.length} 个模型。`,
        });
      } catch (err) {
        results.push({
          provider: 'openai',
          available: false,
          baseUrl: openaiUrl,
          models: [],
          note: `连接失败：${err.message}`,
        });
      }
    } else if (openaiUrl) {
      results.push({
        provider: 'openai',
        available: false,
        baseUrl: openaiUrl,
        models: [],
        note: '已填写地址但缺少 API Key。',
      });
    }

    return results;
  }

  async chat(messages, { onRetry } = {}) {
    switch (this.provider) {
      case 'openai':
        return withRetry(() => this._chatOpenAI(messages), { onRetry });
      case 'anthropic':
        return withRetry(() => this._chatAnthropic(messages), { onRetry });
      case 'ollama':
      default:
        return withRetry(() => this._chatOllama(messages), { onRetry });
    }
  }

  async _chatOllama(messages) {
    if (!this.model) throw new Error('未指定模型名。请先运行探测并选择模型。');
    const res = await httpRequest(`${this.baseUrl || 'http://127.0.0.1:11434'}/api/chat`, {
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        format: 'json',       // Ollama 原生 JSON 模式，显著提升可解析率
        options: { temperature: this.temperature, num_predict: this.maxTokens },
      }),
      headers: { 'Content-Type': 'application/json' },
      timeout: this.timeout,
    });
    const data = JSON.parse(res.text);
    const content = data.message?.content ?? data.response ?? '';
    if (!content) throw new Error('Ollama 返回空内容');
    return { content, usage: data.eval_count ? { completion_tokens: data.eval_count } : {} };
  }

  async _chatOpenAI(messages) {
    if (!this.baseUrl) throw new Error('未配置 OpenAI 兼容端点地址');
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const payload = {
      model: this.model,
      messages,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      response_format: { type: 'json_object' },
    };
    const res = await httpRequest(`${this.baseUrl}/chat/completions`, {
      body: JSON.stringify(payload),
      headers,
      timeout: this.timeout,
    });
    const data = JSON.parse(res.text);
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`OpenAI 响应无内容: ${res.text.slice(0, 200)}`);
    return { content, usage: data.usage || {} };
  }

  async _chatAnthropic(messages) {
    if (!this.apiKey) throw new Error('未配置 Anthropic API Key');
    const base = this.baseUrl || 'https://api.anthropic.com';
    const system = messages.find((m) => m.role === 'system')?.content || '';
    const chat = messages.filter((m) => m.role !== 'system').map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));
    // 保证首条为 user
    if (!chat.length || chat[0].role !== 'user') {
      chat.unshift({ role: 'user', content: '(please extract memories)' });
    }

    const res = await httpRequest(`${base}/v1/messages`, {
      body: JSON.stringify({
        model: this.model || 'claude-sonnet-5',
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        system: system || undefined,
        messages: chat,
      }),
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      timeout: this.timeout,
    });
    const data = JSON.parse(res.text);
    const content = (data.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');
    if (!content) throw new Error('Anthropic 响应无文本内容');
    return { content, usage: data.usage || {} };
  }

  /**
   * 并发池执行。
   */
  async runPool(items, worker, { onProgress, signal } = {}) {
    const results = new Array(items.length);
    let cursor = 0;
    let done = 0;

    const runners = Array.from({ length: Math.min(this.concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        if (signal?.aborted) return;
        const idx = cursor++;
        try {
          results[idx] = { ok: true, value: await worker(items[idx], idx) };
        } catch (err) {
          results[idx] = { ok: false, error: err.message };
        }
        done++;
        if (onProgress) onProgress({ done, total: items.length, index: idx });
      }
    });

    await Promise.all(runners);
    return results;
  }
}

module.exports = { LLMClient, parseLooseJSON, httpRequest, isRetryable };
