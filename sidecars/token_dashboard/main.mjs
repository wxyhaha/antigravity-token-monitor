/**
 * Token & TPS Monitor sidecar backend.
 *
 * Reads Antigravity conversation SQLite databases, transcripts, and annotations
 * in read-only mode to compute real-time Token consumption, Prompt Cache hit
 * rates, TTFT, TPS (Tokens Per Second), and per-round/per-step model attribution.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;
const VERSION = '2.1.0';

const STEP_TYPE_LABELS = {
  14: '用户提问',
  15: '模型响应',
  17: '子任务',
  23: '任务节点',
  101: '上下文检查点',
  132: '工具调用',
};

const STEP_STATUS_LABELS = {
  1: '排队中',
  2: '执行中',
  3: '已完成',
  5: '已取消',
  6: '已跳过',
  7: '报错',
};

const KNOWN_MODEL_ENUMS = {
  1298: { name: 'Gemini 3.7 Flash', slug: 'gemini-3.7-flash', role: '' },
  1318: { name: 'Gemini 3.8 Flash (High)', slug: 'gemini-3.8-flash', role: '' },
  1319: { name: 'Gemini 3.8 Flash (Medium)', slug: 'gemini-3.8-flash-n', role: '' },
  1405: { name: 'Claude Sonnet 5.5 (High)', slug: 'claude-sonnet-5-5-high', role: '' },
  1417: { name: 'Gemini 4 Argon (High)', slug: 'gemini-4-argon-trial', role: '' },
  1418: { name: 'Gemini 4 Argon (Medium)', slug: 'gemini-4-argon-trial', role: '' },
  1526: { name: 'Gemini 4 Hydrogen (Medium)', slug: 'gemini-4-hydrogen', role: '' },
  1528: { name: 'Gemini 4 Hydrogen (XHigh)', slug: 'gemini-4-hydrogen', role: '' },
  1668: { name: 'Orchestrator (Argon)', slug: 'gemini-pro-orchestrator-g1-pro', role: '规划' },
  1669: { name: 'Gemini Flash', slug: 'gemini-flash-worker-agy', role: '执行' },
};

const STATIC_ASSETS = {
  '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', contentType: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', contentType: 'application/javascript; charset=utf-8' },
};

// Cache parsed conversation summaries keyed by file mtimes/sizes.
const convCache = new Map();

/** Discover Antigravity and Antigravity IDE data directories on this machine. */
function findAppDataDirs() {
  const dirs = [];
  const seen = new Set();
  const addIfValid = (dirPath, surfaceHint) => {
    if (!dirPath || seen.has(dirPath)) return;
    if (!existsSync(join(dirPath, 'conversations')) && !existsSync(join(dirPath, 'brain'))) return;
    seen.add(dirPath);
    const name = basename(dirPath).toLowerCase();
    const surface = surfaceHint || (name.includes('ide') ? 'IDE' : 'Desktop');
    dirs.push({ path: dirPath, surface });
  };

  const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execDataDir) {
    for (let d = execDataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        addIfValid(dirname(d));
        break;
      }
    }
  }

  const root = join(homedir(), '.gemini');
  addIfValid(join(root, 'antigravity'), 'Desktop');
  addIfValid(join(root, 'antigravity-ide'), 'IDE');
  return dirs;
}

function safeReaddir(dirPath) {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

function statOf(filePath) {
  try {
    const s = statSync(filePath);
    return { mtime: Math.round(s.mtimeMs), size: s.size };
  } catch {
    return { mtime: 0, size: -1 };
  }
}

/** Decode a protobuf varint starting at `offset`, returning `[number, nextOffset]`. */
function readVarint(buf, offset) {
  let val = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    val |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) {
      return [Number(val), i];
    }
    shift += 7n;
  }
  return [Number(val), i];
}

/** Parse a protobuf buffer into `{ [fieldNumber]: lastValue }` and optional `all` map. */
function parseProto(buf, collectAll = false) {
  const single = {};
  const all = collectAll ? {} : null;
  if (!buf || !buf.length) return collectAll ? { single, all } : single;

  let i = 0;
  while (i < buf.length) {
    const [tag, nextI] = readVarint(buf, i);
    i = nextI;
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 0) break;

    let val;
    if (wt === 0) {
      const [v, ni] = readVarint(buf, i);
      i = ni;
      val = v;
    } else if (wt === 2) {
      const [len, ni] = readVarint(buf, i);
      i = ni;
      if (len < 0 || i + len > buf.length) break;
      val = buf.subarray(i, i + len);
      i += len;
    } else if (wt === 5) {
      i += 4;
      continue;
    } else if (wt === 1) {
      i += 8;
      continue;
    } else {
      break;
    }

    single[fn] = val;
    if (collectAll) {
      if (!all[fn]) all[fn] = [];
      all[fn].push(val);
    }
  }
  return collectAll ? { single, all } : single;
}

/** Convert a protobuf Timestamp/Duration submessage `{ 1: seconds, 2: nanos }` to ms. */
function parseSecondsNanosMs(buf) {
  if (!buf) return 0;
  const p = parseProto(buf);
  const sec = Number(p[1] || 0);
  const nanos = Number(p[2] || 0);
  if (!sec && !nanos) return 0;
  return sec * 1000 + Math.round(nanos / 1e6);
}

/** Decode a UTF-8 byte slice safely. */
function decodeUtf8(buf) {
  if (!buf) return '';
  return Buffer.from(buf).toString('utf8').trim();
}

/** Extract clean, human-readable error message from a `steps.error_details` blob. */
function decodeErrorDetails(buf) {
  if (!buf || !buf.length) return '';
  const text = Buffer.from(buf)
    .toString('utf8')
    .replace(/[^\x20-\x7e\u4e00-\u9fa5\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const stackIdx = text.indexOf('(1) Wraps:');
  const trimmed = stackIdx > 0 ? text.slice(0, stackIdx).trim() : text;
  return trimmed.length > 220 ? `${trimmed.slice(0, 219)}…` : trimmed;
}

/** Classify a backend API error message into a concise Chinese label. */
function classifyApiError(msg) {
  const s = String(msg || '').toLowerCase();
  if (s.includes('503') || s.includes('no capacity') || s.includes('unavailable')) {
    return '503 算力不足';
  }
  if (s.includes('429') || s.includes('resource_exhausted') || s.includes('quota') || s.includes('rate limit')) {
    return '429 配额/限流';
  }
  if (s.includes('idle timeout') || s.includes('deadline exceeded') || s.includes('timeout')) {
    return '请求超时';
  }
  if (s.includes('unexpected eof') || s.includes('wsarecv') || s.includes('closed network connection') || s.endsWith(': eof')) {
    return '网络连接中断';
  }
  if (s.includes('failed_precondition') || s.includes('location is not supported')) {
    return '400 地区/前置条件受限';
  }
  if (s.includes('context canceled by user')) {
    return '用户取消';
  }
  return '后端接口报错';
}

/** Extract tool name and short summary from a `step_type=132` metadata blob. */
function parseToolStepMeta(buf) {
  if (!buf || !buf.length) return { toolName: '', toolSummary: '' };
  const text = Buffer.from(buf).toString('utf8').replace(/[^\x20-\x7e\u4e00-\u9fa5]/g, ' ');
  const m = /\b(call_[a-zA-Z0-9_]+)\s+([a-zA-Z0-9_]+)\s+(\{[\s\S]*)/.exec(text);
  if (!m) {
    const simple = /\b(run_command|read_file|write_file|edit_file|search_web|list_resources|read_resource|invoke_subagent|send_message|manage_task|swarm)\b/.exec(text);
    return { toolName: simple ? simple[1] : '', toolSummary: '' };
  }
  const toolName = m[2];
  let toolSummary = '';
  const summaryMatch = /"toolSummary"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(m[3]);
  if (summaryMatch) {
    try {
      toolSummary = JSON.parse(`"${summaryMatch[1]}"`);
    } catch {
      toolSummary = summaryMatch[1];
    }
  } else {
    const pathMatch = /"(?:Path|AbsolutePath|TargetFile|CommandLine)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(m[3]);
    if (pathMatch) {
      const raw = pathMatch[1];
      toolSummary = toolName === 'run_command' ? raw.slice(0, 48) : basename(raw.replace(/\\\\/g, '/'));
    }
  }
  return { toolName, toolSummary };
}

/** Read recent backend HTTP/API errors from Antigravity's live `language_server.log` tail. */
function readRecentServerLogErrors(windowMs = 120000) {
  const candidates = [
    join(homedir(), 'AppData', 'Roaming', 'Antigravity', 'logs', 'language_server.log'),
    join(homedir(), 'Library', 'Application Support', 'Antigravity', 'logs', 'language_server.log'),
    join(homedir(), '.config', 'Antigravity', 'logs', 'language_server.log'),
  ];
  const results = [];
  const now = new Date();
  const todayMmDd = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

  for (const logPath of candidates) {
    const st = statOf(logPath);
    if (st.size <= 0 || Date.now() - st.mtime > 300000) continue;
    try {
      const len = Math.min(16384, st.size);
      const buf = readFileSync(logPath);
      const tail = buf.subarray(Math.max(0, buf.length - len)).toString('utf8');
      for (const line of tail.split('\n')) {
        if (!line) continue;
        if (/plugins\.go:405|errorreport\.go|connector\.go|extract_searchable_content/i.test(line)) continue;
        const m = new RegExp(`([EW])${todayMmDd} (\\d{2}:\\d{2}:\\d{2})\\.\\d+\\s+\\d+\\s+([^\\]]+)\\]\\s*(.+)$`).exec(line);
        if (!m && !/streamGenerateContent.*(?:error|failed|503|429|timeout|EOF)/i.test(line)) continue;
        const timeStr = m ? m[2] : '';
        if (timeStr) {
          const [hh, mm, ss] = timeStr.split(':').map(Number);
          const logTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, ss).getTime();
          if (now.getTime() - logTime > windowMs) continue;
        }
        const msg = (m ? m[4] : line).trim();
        results.push({
          time: timeStr,
          source: m ? m[3].trim() : 'language_server',
          message: msg.length > 200 ? `${msg.slice(0, 199)}…` : msg,
        });
      }
    } catch {
      // Ignore transient log read errors.
    }
  }
  return results.slice(-5).reverse();
}

/** Resolve display name, internal slug, and role ('规划' | '执行' | '') for a model call. */
function resolveModelInfo(modelEnum, displayFromGen, slugFromGen) {
  const known = KNOWN_MODEL_ENUMS[modelEnum];
  const modelSlug = slugFromGen || known?.slug || '';
  const modelName = displayFromGen || known?.name || modelSlug || (modelEnum ? `Model #${modelEnum}` : 'Unknown');
  let modelRole = known?.role || '';
  if (!modelRole && modelSlug) {
    if (modelSlug.includes('orchestrator')) modelRole = '规划';
    else if (modelSlug.includes('worker')) modelRole = '执行';
  }
  return { modelName, modelSlug, modelRole };
}

/** Parse conversation title and last_user_view_time from `<appData>/annotations/<id>.pbtxt`. */
function readAnnotation(appDataDir, convId) {
  const annPath = join(appDataDir, 'annotations', `${convId}.pbtxt`);
  const st = statOf(annPath);
  if (st.size < 0) return { title: '', lastViewMs: 0, statKey: '0:-1' };

  try {
    const text = readFileSync(annPath, 'utf8');
    const titleMatch = /title:"((?:[^"\\]|\\.)*)"/.exec(text);
    let title = '';
    if (titleMatch) {
      try {
        title = JSON.parse(`"${titleMatch[1]}"`);
      } catch {
        title = titleMatch[1];
      }
    }
    const secMatch = /last_user_view_time:\{[^}]*seconds:(\d+)/.exec(text);
    const lastViewMs = secMatch ? Number(secMatch[1]) * 1000 : 0;
    return { title, lastViewMs, statKey: `${st.mtime}:${st.size}` };
  } catch {
    return { title: '', lastViewMs: 0, statKey: `${st.mtime}:${st.size}` };
  }
}

function unquoteArg(val) {
  if (typeof val !== 'string') return val == null ? '' : String(val);
  const s = val.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

function summarizeToolCalls(calls) {
  if (!Array.isArray(calls) || !calls.length) return '';
  const labels = [];
  for (const tc of calls.slice(0, 3)) {
    const name = tc?.name || '';
    if (!name) continue;
    const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
    const summary = unquoteArg(args.toolSummary) || unquoteArg(args.toolAction);
    if (summary) {
      labels.push(`${name}: ${summary}`);
      continue;
    }
    const pathArg = unquoteArg(args.Path || args.AbsolutePath || args.TargetFile);
    if (pathArg) {
      labels.push(`${name} · ${basename(pathArg)}`);
    } else {
      labels.push(name);
    }
  }
  if (calls.length > 3) labels.push(`+${calls.length - 3}`);
  return labels.join(' | ');
}

function extractThinkingHeading(thinking) {
  if (typeof thinking !== 'string' || !thinking.trim()) return '';
  const matches = [...thinking.matchAll(/(?:^|\n)\s*\*\*([^*\n]{2,80})\*\*\s*(?=\n|$)/g)];
  if (matches.length) return matches[matches.length - 1][1].trim();
  const firstLine = thinking.trim().split('\n')[0].trim();
  return firstLine.length > 64 ? `${firstLine.slice(0, 63)}…` : firstLine;
}

function cleanUserRequestText(rawContent) {
  if (typeof rawContent !== 'string') return '';
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(rawContent);
  const cleaned = (m ? m[1] : rawContent).replace(/\s+/g, ' ').trim();
  return cleaned.length > 72 ? `${cleaned.slice(0, 71)}…` : cleaned;
}

/** Read step summaries, user round prompts, turn activity status, and fallback title from transcript.jsonl. */
function readTranscriptInfo(appDataDir, convId) {
  const trPath = join(appDataDir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  const st = statOf(trPath);
  if (st.size < 0) {
    return {
      stepSummaries: new Map(),
      userPromptsByStepIndex: new Map(),
      isWorking: false,
      firstUserPrompt: '',
      statKey: '0:-1',
    };
  }

  const stepSummaries = new Map();
  const userPromptsByStepIndex = new Map();
  let firstUserPrompt = '';
  let lastType = '';
  let lastCalls = [];
  let lastResultsCount = 0;

  try {
    const lines = readFileSync(trPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object') continue;
      lastType = obj.type || '';
      if (obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
        const promptText = cleanUserRequestText(obj.content);
        if (promptText) {
          if (!firstUserPrompt) {
            firstUserPrompt = promptText.length > 48 ? `${promptText.slice(0, 47)}…` : promptText;
          }
          if (Number.isFinite(obj.step_index)) {
            userPromptsByStepIndex.set(obj.step_index, promptText);
          }
        }
      }
      if (obj.type === 'PLANNER_RESPONSE') {
        const calls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
        lastCalls = calls;
        lastResultsCount = 0;
        const toolText = summarizeToolCalls(calls);
        const thinkText = extractThinkingHeading(obj.thinking);
        const summary = toolText || (thinkText ? `思考: ${thinkText}` : '直接回复');
        if (Number.isFinite(obj.step_index)) {
          stepSummaries.set(obj.step_index, summary);
        }
      } else if (obj.type === 'GENERIC') {
        lastResultsCount++;
      }
    }
  } catch {
    // Ignore transient read errors while transcript is flushing.
  }

  // Mid-turn if the last recorded event is USER_INPUT or tool calls still awaiting results.
  const isWorking =
    lastType === 'USER_INPUT' ||
    (lastType === 'PLANNER_RESPONSE' && lastCalls.length > 0 && lastResultsCount < lastCalls.length) ||
    (lastType === 'GENERIC' && lastCalls.length > 0 && lastResultsCount < lastCalls.length);

  return { stepSummaries, userPromptsByStepIndex, isWorking, firstUserPrompt, statKey: `${st.mtime}:${st.size}` };
}

/** Extract structured generation records from the `gen_metadata` table. */
function parseGenMetadataRows(db) {
  const records = [];
  let rows = [];
  try {
    rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all();
  } catch {
    return records;
  }

  for (const row of rows) {
    const outer = parseProto(row.data);
    if (!outer[1]) continue;
    const { single: f1, all: f1All } = parseProto(outer[1], true);
    const usage = f1[4] ? parseProto(f1[4]) : {};
    const kvEntries = f1All[20] || [];
    let lastStepIndex = null;
    for (const kvBuf of kvEntries) {
      const kv = parseProto(kvBuf);
      if (decodeUtf8(kv[1]) === 'last_step_index') {
        const parsed = Number.parseInt(decodeUtf8(kv[2]), 10);
        if (Number.isFinite(parsed)) lastStepIndex = parsed;
      }
    }
    const modelEnum = usage[1] ?? f1[3] ?? 0;
    const resolved = resolveModelInfo(modelEnum, decodeUtf8(f1[21]), decodeUtf8(f1[19]));

    const apiErrors = [];
    for (const errBuf of f1All[17] || []) {
      const errProto = parseProto(errBuf);
      const errMsg = decodeUtf8(errProto[3]);
      if (!errMsg) continue;
      const kind = Number(errProto[5] || 0);
      const retryBackoffMs = parseSecondsNanosMs(errProto[7]);
      apiErrors.push({
        label: classifyApiError(errMsg),
        message: errMsg.length > 220 ? `${errMsg.slice(0, 219)}…` : errMsg,
        kind,
        isRetryable: kind === 1,
        isTerminal: kind === 3,
        retryBackoffMs,
      });
    }

    records.push({
      idx: row.idx,
      modelEnum,
      modelName: resolved.modelName,
      modelSlug: resolved.modelSlug,
      modelRole: resolved.modelRole,
      inTok: usage[2] || 0,
      outTok: usage[3] || 0,
      cacheTok: usage[5] || 0,
      thinkTok: usage[9] || 0,
      bodyTok: usage[10] || 0,
      ttftMs: parseSecondsNanosMs(f1[11]),
      streamMs: parseSecondsNanosMs(f1[12]),
      lastStepIndex,
      apiErrors,
    });
  }
  return records;
}

/** Match a `steps` row with its corresponding `gen_metadata` record, if available. */
function matchGenRecord(genRecords, usedIndices, stepIdx, inTok, outTok, thinkTok) {
  for (let i = 0; i < genRecords.length; i++) {
    if (usedIndices.has(i)) continue;
    const g = genRecords[i];
    if (g.inTok === inTok && g.outTok === outTok && g.thinkTok === thinkTok) {
      usedIndices.add(i);
      return g;
    }
  }
  for (let i = 0; i < genRecords.length; i++) {
    if (usedIndices.has(i)) continue;
    const g = genRecords[i];
    if (g.lastStepIndex !== null && Math.abs(stepIdx - g.lastStepIndex) <= 2) {
      usedIndices.add(i);
      return g;
    }
  }
  return null;
}

/** Build per-model breakdown sorted by callCount desc. */
function buildModelBreakdown(steps) {
  const map = new Map();
  for (const s of steps) {
    const key = `${s.modelName}|${s.modelSlug}`;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        modelName: s.modelName,
        modelSlug: s.modelSlug,
        modelRole: s.modelRole,
        callCount: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        bodyTokens: 0,
        totalDurationMs: 0,
        peakTps: 0,
      };
      map.set(key, entry);
    }
    entry.callCount++;
    entry.inputTokens += s.inputTokens;
    entry.cacheReadTokens += s.cacheReadTokens;
    entry.outputTokens += s.outputTokens;
    entry.thinkingTokens += s.thinkingTokens;
    entry.bodyTokens += s.bodyTokens;
    entry.totalDurationMs += s.totalMs;
    if (s.tps > entry.peakTps) entry.peakTps = s.tps;
  }

  return [...map.values()]
    .map((m) => ({
      ...m,
      avgTps: m.totalDurationMs > 0 && m.outputTokens > 0
        ? +(m.outputTokens / (m.totalDurationMs / 1000)).toFixed(1)
        : 0,
    }))
    .sort((a, b) => b.callCount - a.callCount || b.outputTokens - a.outputTokens);
}

/** Build per-round aggregates and step timelines. */
function buildRounds(steps, roundMetaMap) {
  const roundMap = new Map();

  for (const s of steps) {
    const rIdx = s.roundIndex;
    let r = roundMap.get(rIdx);
    if (!r) {
      const meta = roundMetaMap.get(rIdx);
      r = {
        roundIndex: rIdx,
        prompt: meta?.prompt || s.roundPrompt || `第 ${rIdx} 轮对话`,
        callCount: 0,
        totalInputTokens: 0,
        totalCacheReadTokens: 0,
        totalOutputTokens: 0,
        totalDurationMs: 0,
        modelsMap: new Map(),
        steps: [],
      };
      roundMap.set(rIdx, r);
    }
    r.callCount++;
    r.totalInputTokens += s.inputTokens;
    r.totalCacheReadTokens += s.cacheReadTokens;
    r.totalOutputTokens += s.outputTokens;
    r.totalDurationMs += s.totalMs;
    r.steps.push(s);

    const mKey = `${s.modelName}|${s.modelSlug}`;
    const existingM = r.modelsMap.get(mKey);
    if (existingM) {
      existingM.count++;
    } else {
      r.modelsMap.set(mKey, {
        modelName: s.modelName,
        modelSlug: s.modelSlug,
        modelRole: s.modelRole,
        count: 1,
      });
    }
  }

  return [...roundMap.values()]
    .sort((a, b) => a.roundIndex - b.roundIndex)
    .map((r) => ({
      roundIndex: r.roundIndex,
      prompt: r.prompt,
      callCount: r.callCount,
      modelsUsed: [...r.modelsMap.values()],
      totalInputTokens: r.totalInputTokens,
      totalCacheReadTokens: r.totalCacheReadTokens,
      totalOutputTokens: r.totalOutputTokens,
      totalDurationMs: r.totalDurationMs,
      avgTps: r.totalDurationMs > 0 && r.totalOutputTokens > 0
        ? +(r.totalOutputTokens / (r.totalDurationMs / 1000)).toFixed(1)
        : 0,
      steps: r.steps,
    }));
}

/** Build real-time pipeline steps, active request phase, and backend error diagnostics. */
function buildLiveFlowState(stepRows, genRecords, tr, latestModelName) {
  const now = Date.now();
  const apiErrorsByStep = new Map();
  const allErrors = [];

  for (const g of genRecords) {
    if (!g.apiErrors || !g.apiErrors.length) continue;
    const sIdx = g.lastStepIndex;
    for (const err of g.apiErrors) {
      if (sIdx !== null) {
        if (!apiErrorsByStep.has(sIdx)) apiErrorsByStep.set(sIdx, []);
        apiErrorsByStep.get(sIdx).push(err);
      }
      allErrors.push({
        source: 'api',
        stepIndex: sIdx,
        modelName: g.modelName || latestModelName || 'Unknown',
        label: err.label,
        message: err.message,
        isRetryable: err.isRetryable,
        isTerminal: err.isTerminal,
        retryBackoffMs: err.retryBackoffMs,
      });
    }
  }

  for (const row of stepRows) {
    if (row.status === 7 || (row.error_details && row.error_details.length)) {
      const msg = decodeErrorDetails(row.error_details);
      if (msg) {
        allErrors.push({
          source: 'step',
          stepIndex: row.idx,
          modelName: latestModelName || '',
          label: '步骤执行报错',
          message: msg,
          isRetryable: false,
          isTerminal: true,
          retryBackoffMs: 0,
        });
      }
    }
  }

  let lastUserPos = -1;
  for (let i = stepRows.length - 1; i >= 0; i--) {
    if (stepRows[i].step_type === 14) {
      lastUserPos = i;
      break;
    }
  }
  const sliceStart = lastUserPos >= 0 ? lastUserPos : Math.max(0, stepRows.length - 10);
  const currentRows = stepRows.slice(sliceStart);

  const livePipeline = [];
  for (const row of currentRows) {
    const meta = parseProto(row.metadata);
    const createdAtMs = parseSecondsNanosMs(meta[1]);
    const firstTokenAtMs = parseSecondsNanosMs(meta[6]);
    const completedAtMs = parseSecondsNanosMs(meta[7]);
    const errorMessage = decodeErrorDetails(row.error_details);
    const linkedApiErrors = apiErrorsByStep.get(row.idx) || [];

    let title = STEP_TYPE_LABELS[row.step_type] || `步骤 #${row.step_type}`;
    let modelName = '';
    let modelSlug = '';
    let modelRole = '';
    let elapsedMs = 0;

    if (row.step_type === 14) {
      title = tr.userPromptsByStepIndex.get(row.idx) || '用户提问';
    } else if (row.step_type === 132) {
      const toolInfo = parseToolStepMeta(row.metadata);
      title = toolInfo.toolName
        ? (toolInfo.toolSummary ? `${toolInfo.toolName} · ${toolInfo.toolSummary}` : toolInfo.toolName)
        : (tr.stepSummaries.get(row.idx) || '工具调用');
    } else if (row.step_type === 15) {
      const u = meta[9] ? parseProto(meta[9]) : {};
      const gen = genRecords.find((g) => g.lastStepIndex === row.idx);
      const resolved = gen
        ? { modelName: gen.modelName, modelSlug: gen.modelSlug, modelRole: gen.modelRole }
        : resolveModelInfo(u[1] || 0, '', '');
      modelName = resolved.modelName !== 'Unknown' ? resolved.modelName : (latestModelName || '');
      modelSlug = resolved.modelSlug;
      modelRole = resolved.modelRole;
      title = tr.stepSummaries.get(row.idx) || (row.status === 2 ? (firstTokenAtMs ? '正在输出回复…' : '正在思考 / 等待首字…') : '模型响应');
    }

    if (row.status === 2 && createdAtMs > 0) {
      elapsedMs = Math.max(0, now - createdAtMs);
    } else if (completedAtMs > 0 && createdAtMs > 0 && completedAtMs >= createdAtMs) {
      elapsedMs = completedAtMs - createdAtMs;
    }

    livePipeline.push({
      stepIndex: row.idx,
      stepType: row.step_type,
      kindLabel: STEP_TYPE_LABELS[row.step_type] || `Type ${row.step_type}`,
      status: row.status,
      statusLabel: STEP_STATUS_LABELS[row.status] || `状态 ${row.status}`,
      title,
      modelName,
      modelSlug,
      modelRole,
      createdAtMs,
      firstTokenAtMs,
      completedAtMs,
      elapsedMs,
      errorMessage,
      apiErrors: linkedApiErrors,
    });
  }

  const runningStep = [...livePipeline].reverse().find((s) => s.status === 2);
  const pendingStep = [...livePipeline].reverse().find((s) => s.status === 1);
  const erroredStep = [...livePipeline].reverse().find((s) => s.status === 7);
  const canceledStep = [...livePipeline].reverse().find((s) => s.status === 5);
  const retryErrs = livePipeline.flatMap((s) => s.apiErrors).filter((e) => e.isRetryable);
  const terminalApiErrs = livePipeline.flatMap((s) => s.apiErrors).filter((e) => e.isTerminal && e.label !== '用户取消');
  const activeStep = runningStep || pendingStep || null;
  const isActive = Boolean(activeStep || tr.isWorking);

  let phase = 'IDLE';
  let label = '空闲 / 本轮已完成';
  let detail = livePipeline.length ? `共 ${livePipeline.length} 个流程节点` : '等待新请求…';
  let elapsedMs = 0;

  if (erroredStep && !activeStep) {
    phase = 'ERROR';
    label = '后台已报错';
    detail = erroredStep.errorMessage || `步骤 #${erroredStep.stepIndex} 执行失败`;
  } else if (terminalApiErrs.length && !activeStep) {
    phase = 'ERROR';
    label = terminalApiErrs[terminalApiErrs.length - 1].label;
    detail = terminalApiErrs[terminalApiErrs.length - 1].message;
  } else if (retryErrs.length && isActive) {
    const lastRetry = retryErrs[retryErrs.length - 1];
    phase = 'RETRYING';
    label = `后台异常重试中 (${lastRetry.label})`;
    detail = lastRetry.message;
    elapsedMs = activeStep?.elapsedMs || 0;
  } else if (runningStep) {
    elapsedMs = runningStep.elapsedMs;
    if (runningStep.stepType === 132) {
      phase = 'TOOL_RUNNING';
      label = '工具执行中';
      detail = runningStep.title;
    } else if (runningStep.stepType === 15) {
      if (runningStep.firstTokenAtMs > 0) {
        phase = 'MODEL_STREAMING';
        label = '模型流式输出中';
        detail = runningStep.modelName ? `${runningStep.modelName} · ${runningStep.title}` : runningStep.title;
      } else {
        phase = 'MODEL_WAITING';
        label = '等待模型首字响应';
        detail = runningStep.modelName ? `${runningStep.modelName} · 思考/排队中` : '等待后端返回…';
      }
    } else {
      phase = 'MODEL_WAITING';
      label = '请求处理中';
      detail = runningStep.title;
    }
  } else if (pendingStep) {
    phase = 'MODEL_WAITING';
    label = '步骤排队中';
    detail = pendingStep.title;
    elapsedMs = pendingStep.elapsedMs;
  } else if (canceledStep && !isActive) {
    phase = 'CANCELED';
    label = '本轮已取消';
    detail = `步骤 #${canceledStep.stepIndex} 已中止`;
  } else if (tr.isWorking) {
    phase = 'MODEL_WAITING';
    label = '等待模型响应';
    detail = latestModelName ? `${latestModelName} · 请求已发出` : '正在等待后端流式返回…';
  }

  const stallWarning = phase === 'ERROR' || phase === 'RETRYING' || (isActive && elapsedMs >= 30000);

  return {
    liveState: {
      isActive,
      phase,
      label,
      detail,
      elapsedMs,
      stallWarning,
      errorCount: allErrors.length,
      retryCount: retryErrs.length,
      activeStepIndex: activeStep?.stepIndex ?? null,
    },
    livePipeline: livePipeline.slice(-14),
    recentErrors: allErrors.slice(-8).reverse(),
  };
}

/** Compute per-step, per-round, per-model, and aggregate metrics for one conversation SQLite DB. */
function parseConversation(appDataDir, surface, convId) {
  const dbPath = join(appDataDir, 'conversations', `${convId}.db`);
  const dbStat = statOf(dbPath);
  if (dbStat.size < 0) return null;

  const walStat = statOf(`${dbPath}-wal`);
  const ann = readAnnotation(appDataDir, convId);
  const tr = readTranscriptInfo(appDataDir, convId);
  const cacheKey = `${VERSION}|${dbStat.mtime}:${dbStat.size}|${walStat.mtime}:${walStat.size}|${ann.statKey}|${tr.statKey}`;

  const cached = convCache.get(dbPath);
  if (cached && cached.cacheKey === cacheKey && !cached.data?.liveState?.isActive) {
    return cached.data;
  }

  let stepRows = [];
  let genRecords = [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    genRecords = parseGenMetadataRows(db);
    stepRows = db.prepare('SELECT idx, step_type, status, metadata, error_details FROM steps ORDER BY idx').all();
  } catch {
    return cached ? cached.data : null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore close error on read-only handle.
      }
    }
  }

  const usedGen = new Set();
  const steps = [];
  const roundMetaMap = new Map();
  let currentRound = 0;
  let currentRoundPrompt = '';

  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let totalThinkingTokens = 0;
  let totalBodyTokens = 0;
  let totalDurationMs = 0;
  let totalTtftMs = 0;
  let ttftCount = 0;
  let peakContextTokens = 0;
  let peakTps = 0;
  let peakStreamTps = 0;
  let latestModelName = '';
  let lastActivityMs = ann.lastViewMs || dbStat.mtime || 0;

  for (const row of stepRows) {
    if (row.step_type === 14) {
      currentRound++;
      currentRoundPrompt = tr.userPromptsByStepIndex.get(row.idx) || `第 ${currentRound} 轮提问`;
      roundMetaMap.set(currentRound, {
        userStepIndex: row.idx,
        prompt: currentRoundPrompt,
      });
      continue;
    }

    const meta = parseProto(row.metadata);
    if (!meta[9]) continue;

    if (currentRound === 0) {
      currentRound = 1;
      currentRoundPrompt = tr.firstUserPrompt || '第 1 轮提问';
      roundMetaMap.set(1, { userStepIndex: 0, prompt: currentRoundPrompt });
    }

    const u = parseProto(meta[9]);
    const inTok = u[2] || 0;
    const outTok = u[3] || 0;
    const cacheTok = u[5] || 0;
    const thinkTok = u[9] || 0;
    const bodyTok = u[10] || Math.max(0, outTok - thinkTok);
    const stepModelEnum = u[1] || 0;

    const gen = matchGenRecord(genRecords, usedGen, row.idx, inTok, outTok, thinkTok);
    const resolvedModel = gen
      ? { modelName: gen.modelName, modelSlug: gen.modelSlug, modelRole: gen.modelRole }
      : resolveModelInfo(stepModelEnum, '', '');

    if (resolvedModel.modelName) latestModelName = resolvedModel.modelName;

    const createdAtMs = parseSecondsNanosMs(meta[1]);
    const firstTokenAtMs = parseSecondsNanosMs(meta[6]);
    const completedAtMs = parseSecondsNanosMs(meta[7]);

    let ttftMs = 0;
    if (firstTokenAtMs && createdAtMs && firstTokenAtMs >= createdAtMs) {
      ttftMs = firstTokenAtMs - createdAtMs;
    } else if (gen?.ttftMs) {
      ttftMs = gen.ttftMs;
    }

    let decodeMs = 0;
    if (completedAtMs && firstTokenAtMs && completedAtMs >= firstTokenAtMs) {
      decodeMs = completedAtMs - firstTokenAtMs;
    } else if (gen?.streamMs) {
      decodeMs = gen.streamMs;
    }

    let totalMs = 0;
    if (completedAtMs && createdAtMs && completedAtMs > createdAtMs) {
      totalMs = completedAtMs - createdAtMs;
    } else {
      totalMs = Math.max(1, ttftMs + decodeMs);
    }

    const tps = totalMs > 0 && outTok > 0 ? +(outTok / (totalMs / 1000)).toFixed(1) : 0;
    const streamTps = decodeMs >= 80 && bodyTok > 0 ? +(bodyTok / (decodeMs / 1000)).toFixed(1) : null;
    const contextTokens = inTok + cacheTok;
    const cacheHitRate = contextTokens > 0 ? +((cacheTok / contextTokens) * 100).toFixed(1) : 0;
    const prefillTps = ttftMs > 0 && contextTokens > 0 ? Math.round(contextTokens / (ttftMs / 1000)) : 0;

    if (completedAtMs > lastActivityMs) lastActivityMs = completedAtMs;
    else if (createdAtMs > lastActivityMs) lastActivityMs = createdAtMs;

    totalInputTokens += inTok;
    totalCacheReadTokens += cacheTok;
    totalOutputTokens += outTok;
    totalThinkingTokens += thinkTok;
    totalBodyTokens += bodyTok;
    totalDurationMs += totalMs;
    if (ttftMs > 0) {
      totalTtftMs += ttftMs;
      ttftCount++;
    }
    if (contextTokens > peakContextTokens) peakContextTokens = contextTokens;
    if (tps > peakTps) peakTps = tps;
    if (streamTps && streamTps > peakStreamTps) peakStreamTps = streamTps;

    steps.push({
      stepIndex: row.idx,
      roundIndex: currentRound,
      roundPrompt: currentRoundPrompt,
      modelEnum: gen?.modelEnum || stepModelEnum,
      modelName: resolvedModel.modelName,
      modelSlug: resolvedModel.modelSlug,
      modelRole: resolvedModel.modelRole,
      createdAtMs: createdAtMs || lastActivityMs,
      completedAtMs: completedAtMs || createdAtMs || lastActivityMs,
      inputTokens: inTok,
      cacheReadTokens: cacheTok,
      contextTokens,
      cacheHitRate,
      outputTokens: outTok,
      thinkingTokens: thinkTok,
      bodyTokens: bodyTok,
      ttftMs,
      decodeMs,
      totalMs,
      tps,
      streamTps,
      prefillTps,
      summary: tr.stepSummaries.get(row.idx) || '模型调用',
    });
  }

  const totalContextProcessed = totalInputTokens + totalCacheReadTokens;
  const cacheHitRate = totalContextProcessed > 0
    ? +((totalCacheReadTokens / totalContextProcessed) * 100).toFixed(1)
    : 0;
  const avgTps = totalDurationMs > 0 && totalOutputTokens > 0
    ? +(totalOutputTokens / (totalDurationMs / 1000)).toFixed(1)
    : 0;
  const avgTtftMs = ttftCount > 0 ? Math.round(totalTtftMs / ttftCount) : 0;
  const avgStepMs = steps.length > 0 ? Math.round(totalDurationMs / steps.length) : 0;

  const modelBreakdown = buildModelBreakdown(steps);
  const rounds = buildRounds(steps, roundMetaMap);
  const liveFlow = buildLiveFlowState(stepRows, genRecords, tr, latestModelName);

  const data = {
    id: convId,
    surface,
    title: ann.title || tr.firstUserPrompt || `对话 ${convId.slice(0, 8)}`,
    modelName: latestModelName || 'Unknown',
    isWorking: liveFlow.liveState.isActive,
    liveState: liveFlow.liveState,
    livePipeline: liveFlow.livePipeline,
    recentErrors: liveFlow.recentErrors,
    lastActivityMs,
    callCount: steps.length,
    roundCount: rounds.length,
    totalInputTokens,
    totalCacheReadTokens,
    totalContextProcessed,
    totalOutputTokens,
    totalThinkingTokens,
    totalBodyTokens,
    totalAllTokens: totalInputTokens + totalCacheReadTokens + totalOutputTokens,
    peakContextTokens,
    latestContextTokens: steps.length ? steps[steps.length - 1].contextTokens : 0,
    cacheHitRate,
    totalDurationMs,
    avgTps,
    peakTps,
    peakStreamTps,
    avgTtftMs,
    avgStepMs,
    latestStep: steps.length ? steps[steps.length - 1] : null,
    modelBreakdown,
    rounds,
    steps,
  };

  if (convCache.size > 300) convCache.clear();
  convCache.set(dbPath, { cacheKey, data });
  return data;
}

/** Collect all conversations across discovered app data dirs and compute global totals. */
function buildStatsSnapshot(requestedConvId) {
  const dirs = findAppDataDirs();
  const byId = new Map();

  for (const { path: appDataDir, surface } of dirs) {
    const convFiles = safeReaddir(join(appDataDir, 'conversations'));
    for (const file of convFiles) {
      if (!file.endsWith('.db')) continue;
      const convId = file.slice(0, -3);
      if (!UUID_RE.test(convId)) continue;
      const parsed = parseConversation(appDataDir, surface, convId);
      if (!parsed) continue;
      const existing = byId.get(convId);
      if (!existing || parsed.lastActivityMs > existing.lastActivityMs) {
        byId.set(convId, parsed);
      }
    }
  }

  const allConversations = [...byId.values()].sort((a, b) => b.lastActivityMs - a.lastActivityMs);

  // Determine the active conversation: explicit query param > env > most recently active.
  const preferredId = requestedConvId || process.env.ANTIGRAVITY_CONVERSATION_ID || '';
  let active = allConversations.find((c) => c.id === preferredId) || allConversations[0] || null;

  let gCalls = 0;
  let gInput = 0;
  let gCache = 0;
  let gOutput = 0;
  let gThinking = 0;
  let gBody = 0;
  let gDurationMs = 0;

  const conversationList = allConversations.map((c) => {
    gCalls += c.callCount;
    gInput += c.totalInputTokens;
    gCache += c.totalCacheReadTokens;
    gOutput += c.totalOutputTokens;
    gThinking += c.totalThinkingTokens;
    gBody += c.totalBodyTokens;
    gDurationMs += c.totalDurationMs;

    return {
      id: c.id,
      surface: c.surface,
      title: c.title,
      modelName: c.modelName,
      modelsSummary: c.modelBreakdown.map((m) => m.modelName),
      isWorking: c.isWorking,
      lastActivityMs: c.lastActivityMs,
      callCount: c.callCount,
      roundCount: c.roundCount,
      totalInputTokens: c.totalInputTokens,
      totalCacheReadTokens: c.totalCacheReadTokens,
      totalOutputTokens: c.totalOutputTokens,
      totalThinkingTokens: c.totalThinkingTokens,
      totalBodyTokens: c.totalBodyTokens,
      totalAllTokens: c.totalAllTokens,
      peakContextTokens: c.peakContextTokens,
      cacheHitRate: c.cacheHitRate,
      avgTps: c.avgTps,
      peakTps: c.peakTps,
      avgTtftMs: c.avgTtftMs,
    };
  });

  const gContext = gInput + gCache;
  const global = {
    conversationCount: allConversations.length,
    totalCalls: gCalls,
    totalInputTokens: gInput,
    totalCacheReadTokens: gCache,
    totalOutputTokens: gOutput,
    totalThinkingTokens: gThinking,
    totalBodyTokens: gBody,
    totalAllTokens: gInput + gCache + gOutput,
    cacheHitRate: gContext > 0 ? +((gCache / gContext) * 100).toFixed(1) : 0,
    avgTps: gDurationMs > 0 && gOutput > 0 ? +(gOutput / (gDurationMs / 1000)).toFixed(1) : 0,
    totalDurationMs: gDurationMs,
  };

  return {
    version: VERSION,
    generatedAtMs: Date.now(),
    hostConversationId: preferredId,
    activeConversation: active,
    conversations: conversationList,
    serverErrors: readRecentServerLogErrors(),
    global,
  };
}

function serveStaticAsset(routePath) {
  const spec = STATIC_ASSETS[routePath];
  if (!spec) return null;
  const body = readFileSync(join(__dirname, spec.file), 'utf8');
  return new Response(body, {
    contentType: spec.contentType,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function startSidecarMode() {
  const app = new SidecarApp();
  for (const routePath of Object.keys(STATIC_ASSETS)) {
    app.page(routePath, () => serveStaticAsset(routePath));
  }
  app.api('/api/stats', (data) => {
    const convId = typeof data?.conversationId === 'string' ? data.conversationId.trim() : '';
    return buildStatsSnapshot(convId);
  }, 'GET');
  return app.run();
}

function startStandaloneServer(port = 4399) {
  const preloadPath = join(__dirname, '..', '..', '..', 'node_modules', 'sidecar_sdk', 'preload.js');
  const preloadBody = existsSync(preloadPath) ? readFileSync(preloadPath, 'utf8') : 'window.sidecar = null;';

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/preload.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(preloadBody);
      return;
    }
    if (req.method === 'GET' && STATIC_ASSETS[url.pathname]) {
      const asset = serveStaticAsset(url.pathname);
      res.writeHead(200, { 'Content-Type': asset.contentType, 'Cache-Control': 'no-store' });
      res.end(asset.body);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/stats') {
      const convId = (url.searchParams.get('conversationId') || '').trim();
      const payload = buildStatsSnapshot(convId);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const boundPort = server.address().port;
      console.log(`[token-monitor] standalone dashboard listening on http://127.0.0.1:${boundPort}`);
      resolve(server);
    });
  });
}

function runSelfTest() {
  const snapshot = buildStatsSnapshot();
  const sample = snapshot.activeConversation;
  const output = {
    ok: true,
    version: snapshot.version,
    conversationsFound: snapshot.global.conversationCount,
    totalCalls: snapshot.global.totalCalls,
    currentConvId: sample?.id || null,
    sampleTitle: sample?.title || null,
    roundCount: sample?.roundCount || 0,
    modelBreakdown: sample?.modelBreakdown || [],
    roundsSummary: (sample?.rounds || []).map((r) => ({
      roundIndex: r.roundIndex,
      prompt: r.prompt,
      callCount: r.callCount,
      modelsUsed: r.modelsUsed,
    })),
    sampleMetrics: sample
      ? {
          callCount: sample.callCount,
          totalInputTokens: sample.totalInputTokens,
          totalCacheReadTokens: sample.totalCacheReadTokens,
          totalOutputTokens: sample.totalOutputTokens,
          totalThinkingTokens: sample.totalThinkingTokens,
          totalBodyTokens: sample.totalBodyTokens,
          cacheHitRate: sample.cacheHitRate,
          avgTps: sample.avgTps,
          peakTps: sample.peakTps,
          avgTtftMs: sample.avgTtftMs,
        }
      : null,
  };
  console.log(JSON.stringify(output, null, 2));
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
} else if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  await startSidecarMode();
} else {
  const idx = process.argv.indexOf('--standalone');
  const rawPort = idx >= 0 ? Number(process.argv[idx + 1]) : 4399;
  const port = Number.isFinite(rawPort) && rawPort >= 0 ? rawPort : 4399;
  await startStandaloneServer(port);
}
