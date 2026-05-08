import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { convertMessages, convertMessagesCompact, extractNewMessages, extractNewUserMessages } from './convert';
import { buildToolInstructions, filterToolsByProfile } from './tools';
import type { Message, ContentPart } from './tools';
import { runClaude, getContextWindow, clearSessionAlias, getSessionMapsSnapshot, loadSessionMapsSnapshot } from './claude';
import type { LogEntry, SessionEntry, ChannelEntry, ToolCall as ToolCallType } from './types';

// --- Session cleanup ---
// Claude CLI subprocess runs with cwd=/tmp. On macOS /tmp → /private/tmp,
// so Claude CLI creates sessions in -private-tmp instead of -tmp.
// Use fs.realpathSync to resolve the symlink and match what Claude CLI does.
const SESSIONS_DIR = path.join(
    process.env.HOME!,
    '.claude/projects',
    '-' + fs.realpathSync('/tmp').replace(/\//g, '-').replace(/^-/, '')
);
const CLEANUP_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 day

interface CleanupResult {
    deleted: number;
    remaining: number;
    error?: string;
}

function cleanupSessions(maxAgeMs: number = CLEANUP_MAX_AGE_MS): CleanupResult {
    try {
        if (!fs.existsSync(SESSIONS_DIR)) return { deleted: 0, remaining: 0 };
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl'));
        const cutoff = Date.now() - maxAgeMs;
        let deleted = 0;
        for (const file of files) {
            const fp = path.join(SESSIONS_DIR, file);
            try {
                const stat = fs.statSync(fp);
                if (stat.mtimeMs < cutoff) { fs.unlinkSync(fp); deleted++; }
            } catch {}
        }
        const remaining = files.length - deleted;
        return { deleted, remaining };
    } catch { return { deleted: 0, remaining: 0, error: 'failed' }; }
}

// Cache session info to avoid sync I/O on every dashboard poll
interface SessionInfo {
    count: number;
    sizeKB: number;
}

let _sessionCache = { data: { count: 0, sizeKB: 0 } as SessionInfo, ts: 0 };
function getSessionInfo(): SessionInfo {
    if (Date.now() - _sessionCache.ts < 10000) return _sessionCache.data; // 10s TTL
    try {
        if (!fs.existsSync(SESSIONS_DIR)) { _sessionCache = { data: { count: 0, sizeKB: 0 }, ts: Date.now() }; return _sessionCache.data; }
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl'));
        let totalSize = 0;
        for (const file of files) {
            try { totalSize += fs.statSync(path.join(SESSIONS_DIR, file)).size; } catch {}
        }
        _sessionCache = { data: { count: files.length, sizeKB: Math.round(totalSize / 1024) }, ts: Date.now() };
        return _sessionCache.data;
    } catch { return { count: 0, sizeKB: 0 }; }
}

// Auto-cleanup on startup
const startupCleanup = cleanupSessions();
if (startupCleanup.deleted > 0) {
    console.log(`[openclaw-claude-bridge] Startup cleanup: deleted ${startupCleanup.deleted} old sessions, ${startupCleanup.remaining} remaining`);
}

// --- Persistence ---
const STATE_FILE = path.join(__dirname, '..', 'state.json');

function saveState(): void {
    try {
        const data = {
            stats: { totalRequests: stats.totalRequests, errors: stats.errors },
            channelMap: Array.from(channelMap.entries()),
            responseMap: Array.from(responseMap.entries()),
            requestLog,
            globalActivity,
            sessionMaps: getSessionMapsSnapshot(),
        };
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, STATE_FILE);
    } catch (err: any) {
        console.warn(`[persist] Failed to save state: ${err.message}`);
    }
}

/** Check if a CLI session file still exists on disk. */
function sessionFileExists(sessionId: string): boolean {
    return fs.existsSync(path.join(SESSIONS_DIR, `${sessionId}.jsonl`));
}

function loadState(): void {
    try {
        if (!fs.existsSync(STATE_FILE)) return;
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

        // Restore stats (cumulative counters only)
        if (data.stats) {
            stats.totalRequests = data.stats.totalRequests || 0;
            stats.errors = data.stats.errors || 0;
        }

        // Restore channelMap — only if CLI session file still exists
        let restored = 0, pruned = 0;
        if (data.channelMap) {
            for (const [key, val] of data.channelMap) {
                if (sessionFileExists(val.sessionId)) {
                    channelMap.set(key, val);
                    restored++;
                } else {
                    pruned++;
                }
            }
        }

        // Restore responseMap — only if CLI session file still exists
        if (data.responseMap) {
            for (const [key, val] of data.responseMap) {
                if (sessionFileExists(val.sessionId)) {
                    responseMap.set(key, val);
                }
            }
        }

        // Restore requestLog
        if (data.requestLog) {
            requestLog.push(...data.requestLog.slice(-MAX_LOG));
        }

        // Restore globalActivity
        if (data.globalActivity) {
            globalActivity.push(...data.globalActivity.slice(-MAX_ACTIVITY));
        }

        // Restore session aliases and token maps so scrubbed tokens emitted by
        // pre-restart Claude CLI sessions can still be mapped back to originals.
        let restoredAliases = 0, restoredTokenMaps = 0;
        if (data.sessionMaps) {
            loadSessionMapsSnapshot(data.sessionMaps);
            restoredAliases = data.sessionMaps.aliases?.length || 0;
            restoredTokenMaps = data.sessionMaps.tokens?.length || 0;
        }

        console.log(`[persist] Loaded: ${restored} channels, ${pruned} pruned (session gone), ${requestLog.length} log entries, ${globalActivity.length} activity, ${restoredAliases} aliases, ${restoredTokenMaps} token maps`);
    } catch (err: any) {
        console.warn(`[persist] Failed to load state: ${err.message}`);
    }
}

// --- Shared state ---
interface Stats {
    startedAt: Date;
    totalRequests: number;
    activeRequests: number;
    lastRequestAt: Date | null;
    lastModel: string | null;
    errors: number;
}

const stats: Stats = {
    startedAt: new Date(),
    totalRequests: 0,
    activeRequests: 0,
    lastRequestAt: null,
    lastModel: null,
    errors: 0,
};

// --- Session reuse tracking ---
const channelMap = new Map<string, ChannelEntry>();
const sessionMap = new Map<string, SessionEntry>();
const responseMap = new Map<string, SessionEntry>();
const MEMORY_GC_TTL_MS = 60 * 60 * 1000; // 1 hour

const MAX_NEW_SESSION_CHARS = 600000;

const MAX_PER_CHANNEL = 1;
const MAX_GLOBAL = parseInt(process.env.MAX_GLOBAL || '') || 20;
const channelActive = new Map<string, number>();
const channelQueues = new Map<string, Promise<void>>();

function acquireChannelLock(routingKey: string): Promise<() => void> {
    const prev = channelQueues.get(routingKey) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    channelQueues.set(routingKey, gate);
    return prev.then(() => {
        return () => {
            release();
            if (channelQueues.get(routingKey) === gate) {
                channelQueues.delete(routingKey);
            }
        };
    });
}

function contentKey(text: string | null): string | null {
    if (!text) return null;
    return text.slice(0, 200);
}

function extractConversationLabel(messages: Message[]): string | null {
    for (const msg of messages) {
        if (msg.role !== 'user') continue;
        const content = typeof msg.content === 'string' ? msg.content
            : Array.isArray(msg.content) ? msg.content.filter(p => p.type === 'text').map(p => (p as any).text).join('\n')
            : '';
        const match = content.match(/Conversation info \(untrusted metadata\):\s*```json\s*(\{[\s\S]*?\})\s*```/);
        if (match) {
            try {
                const meta = JSON.parse(match[1]);
                return meta.conversation_label || (meta.sender ? `dm:${meta.sender}` : null);
            } catch {}
        }
    }
    return null;
}

function extractAgentName(messages: Message[]): string | null {
    for (const msg of messages) {
        if (msg.role !== 'developer' && msg.role !== 'system') continue;
        const text = typeof msg.content === 'string' ? msg.content
            : Array.isArray(msg.content) ? msg.content.filter(p => p.type === 'text').map(p => (p as any).text).join('\n')
            : '';
        const match = text.match(/\*\*Name:\*\*\s*(.+)/);
        if (match) {
            const name = match[1].trim();
            if (name && !name.startsWith('_')) return name;
        }
    }
    return null;
}

function messageText(msg: Message): string {
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter((p: ContentPart) => p && (p.type === 'text' || typeof (p as any).text === 'string'))
            .map((p: ContentPart) => (p as any).text || '')
            .join('\n');
    }
    return '';
}

// OpenClaw periodically asks the model for a short filename slug to title
// sessions. If proxied into a per-channel CLI session it poisons the channel:
// future real prompts resume the title-generation conversation. Intercept the
// request before session routing without touching channelMap/responseMap.
function isSessionTitleSlugRequest(messages: Message[]): boolean {
    return messages.some((msg) => {
        if (msg.role !== 'user') return false;
        const text = messageText(msg).trim();
        return /^(?:User:\s*)?Based on this conversation, generate a short 1-2 word filename slug\b/i.test(text)
            || /generate a short 1-2 word filename slug \(lowercase, hyphen-separated, no file extension\)/i.test(text);
    });
}

function purgeCliSession(cliSessionId: string): void {
    clearSessionAlias(cliSessionId);
    for (const [key, val] of sessionMap) {
        if (val.sessionId === cliSessionId) sessionMap.delete(key);
    }
    for (const [key, val] of responseMap) {
        if (val.sessionId === cliSessionId) responseMap.delete(key);
    }
    const sessionFile = path.join(SESSIONS_DIR, `${cliSessionId}.jsonl`);
    try {
        if (fs.existsSync(sessionFile)) {
            fs.unlinkSync(sessionFile);
            console.log(`[session] Purged old CLI session file: ${cliSessionId}`);
        }
    } catch (err: any) {
        console.warn(`[session] Failed to delete session file ${cliSessionId}: ${err.message}`);
    }
}

function gcMemory(): void {
    const cutoff = Date.now() - MEMORY_GC_TTL_MS;
    for (const [key, val] of sessionMap) {
        if (val.createdAt < cutoff) sessionMap.delete(key);
    }
    for (const [key, val] of responseMap) {
        if (val.createdAt < cutoff) responseMap.delete(key);
    }
}

const MAX_LOG = 200;
const requestLog: LogEntry[] = [];
function pushLog(entry: LogEntry): void {
    requestLog.push(entry);
    if (requestLog.length > MAX_LOG) requestLog.shift();
}

interface ActivityEntry {
    id: string;
    at: number;
    msg: string;
}

const MAX_ACTIVITY = 50;
const globalActivity: ActivityEntry[] = [];
function pushActivity(requestId: string, msg: string): void {
    globalActivity.push({ id: requestId, at: Date.now(), msg });
    if (globalActivity.length > MAX_ACTIVITY) globalActivity.shift();
}

loadState();

interface ParsedToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

// Re-escape unescaped \n \r \t inside JSON string literals so that tool_call
// payloads with raw newlines (common when Claude emits multi-line code) can
// still be parsed. Walks the text tracking string/escape state.
function normalizeJsonish(text: string): string {
    let out = '';
    let inString = false;
    let escape = false;
    for (const ch of text) {
        if (escape) { out += ch; escape = false; continue; }
        if (ch === '\\') { out += ch; escape = true; continue; }
        if (ch === '"') { out += ch; inString = !inString; continue; }
        if (inString) {
            if (ch === '\n') { out += '\\n'; continue; }
            if (ch === '\r') { out += '\\r'; continue; }
            if (ch === '\t') { out += '\\t'; continue; }
        }
        out += ch;
    }
    return out;
}

function parseLooseJson(jsonText: string): { parsed: any; recovered: boolean } {
    try {
        return { parsed: JSON.parse(jsonText), recovered: false };
    } catch (firstErr) {
        const normalized = normalizeJsonish(jsonText);
        if (normalized !== jsonText) {
            try {
                return { parsed: JSON.parse(normalized), recovered: true };
            } catch {}
        }
        throw firstErr;
    }
}

function parseToolCalls(text: string): ParsedToolCall[] {
    const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
    const calls: ParsedToolCall[] = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        const raw = (match[1] || '').trim();
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start === -1 || end === -1 || end < start) {
            console.error(`[parseToolCalls] No JSON object found in block: ${raw.slice(0, 300)}`);
            continue;
        }
        const jsonText = raw.slice(start, end + 1);
        try {
            const { parsed, recovered } = parseLooseJson(jsonText);
            if (!parsed || typeof parsed.name !== 'string') {
                console.error(`[parseToolCalls] Invalid tool_call payload: ${jsonText.slice(0, 300)}`);
                continue;
            }
            if (recovered) {
                console.warn(`[parseToolCalls] Recovered malformed tool_call JSON for ${parsed.name}`);
            }
            const args = (parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments))
                ? parsed.arguments
                : {};
            calls.push({
                id: `call_${uuidv4().slice(0, 8)}`,
                name: parsed.name,
                arguments: args,
            });
        } catch (err) {
            console.error(`[parseToolCalls] Failed to parse JSON: ${jsonText.slice(0, 300)}`);
        }
    }
    return calls;
}

interface ToolDef {
    function?: { name?: string };
    name?: string;
}

function getAvailableToolNames(tools: ToolDef[]): string[] {
    if (!Array.isArray(tools)) return [];
    return tools.map(tool => tool?.function?.name || tool?.name).filter(Boolean) as string[];
}

function filterToolCalls(toolCalls: ParsedToolCall[], availableToolNames: string[]): { valid: ParsedToolCall[]; invalid: ParsedToolCall[] } {
    const allowed = new Set(availableToolNames || []);
    const valid: ParsedToolCall[] = [];
    const invalid: ParsedToolCall[] = [];
    for (const call of toolCalls || []) {
        if (allowed.has(call.name)) valid.push(call);
        else invalid.push(call);
    }
    return { valid, invalid };
}

// Defensive strip of orphan scrub tags. The bridge masks bracket tokens like
// [[reply_to_current]] outbound as [[<word>_<word>_<hex>]] (see generateReplacement
// in claude.ts). When restoreInbound fails — typically because the bridge was
// restarted while a CLI session kept running, losing the in-memory tokenMap —
// these orphans leak as raw text to OpenClaw, causing visible alias prefixes
// and breaking reply-tag detection. Strip anything matching the generated shape.
const ORPHAN_SCRUB_TAG_RE = /\[\[\s*[A-Za-z]+_[A-Za-z]+_[a-f0-9]{4,8}\s*\]\]/g;

function cleanResponseText(text: string): string {
    if (!text) return text;
    const stripped = text
        .replace(/<tool_thinking>[\s\S]*?<\/tool_thinking>/g, '')
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
        .replace(/<tool_result[\s\S]*?<\/tool_result>/g, '')
        .replace(/<previous_response>[\s\S]*?<\/previous_response>/g, '')
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
        .replace(ORPHAN_SCRUB_TAG_RE, '');
    const parts = stripped.split(/(```[\s\S]*?```)/)
    return parts
        .map((part, idx) => idx % 2 === 0 ? part.replace(/\n{3,}/g, '\n\n') : part)
        .join('')
        .trim();
}

function hasInternalBridgeMarkup(text: string): boolean {
    if (!text) return false;
    return /<(?:tool_call|tool_result|tool_thinking|previous_response|system-reminder)\b|<\/(?:tool_call|tool_result|tool_thinking|previous_response|system-reminder)>/i.test(String(text));
}

function redactSensitivePreview(text: string, maxLen = 400): string {
    if (!text) return '';
    return String(text)
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***')
        .replace(/\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|DEEPSEEK_API_KEY)\b\s*[:=]\s*[^\s"']+/gi, '$1=***')
        .replace(/\b(token|api[_-]?key|secret|password)\b\s*[:=]\s*[^\s,}\]"']+/gi, '$1=***')
        .slice(0, maxLen)
        .replace(/\n/g, '\\n');
}
// ─── API app (port 3456, localhost only) ──────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'openclaw-claude-bridge' });
});

app.get('/v1/models', (_req: Request, res: Response) => {
    res.json({
        object: 'list',
        data: [
            { id: 'claude-opus-latest',   object: 'model', created: 1700000000, owned_by: 'anthropic' },
            { id: 'claude-sonnet-latest', object: 'model', created: 1700000000, owned_by: 'anthropic' },
            { id: 'claude-haiku-latest',  object: 'model', created: 1700000000, owned_by: 'anthropic' },
        ],
    });
});

app.post('/v1/chat/completions', async (req: Request, res: Response) => {
    const requestId = uuidv4().slice(0, 8);
    const startTime = Date.now();

    stats.totalRequests++;
    stats.activeRequests++;
    stats.lastRequestAt = new Date();
    let acquiredChannel: string | null = null;
    let releaseChannelLock: (() => void) | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

    console.log(`[${requestId}] POST /v1/chat/completions`);
    const ocSessionKey = (req.headers['x-openclaw-session-key'] as string) || null;
    const ocUser = req.body?.user || null;
    if (ocSessionKey || ocUser) {
        console.log(`[${requestId}] OC identifiers: session-key=${ocSessionKey} user=${ocUser}`);
    }

    const logEntry: any = {
        id: requestId,
        at: new Date().toISOString(),
        model: null as string | null,
        tools: 0,
        promptLen: 0,
        inputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        durationMs: null as number | null,
        status: 'pending',
        error: null as string | null,
        activity: [] as string[],
        cliSessionId: null as string | null,
        resumed: false,
        channel: null as string | null,
        effort: null as string | null,
        thinking: false,
        resumeMethod: null as string | null,
    };
    pushLog(logEntry);

    try {
        const { messages = [], tools = [], model = 'claude-opus-latest', stream = true, reasoning_effort } = req.body;
        stats.lastModel = model;
        logEntry.model = model;
        logEntry.contextWindow = getContextWindow(model);
        logEntry.tools = tools.length;
        logEntry.effort = reasoning_effort || null;
        logEntry.thinking = !!reasoning_effort;
        if (reasoning_effort) console.log(`[${requestId}] reasoning_effort=${reasoning_effort}`);

        if (tools.length > 0) {
            const toolNames = tools.map((t: any) => t.function?.name || t.name).filter(Boolean);
            console.log(`[${requestId}] tools:[${toolNames.join(',')}]`);
        }

        // Memory flush interception
        if (tools.length === 0) {
            const promptLen = messages.reduce((s: number, m: any) => s + JSON.stringify(m.content || '').length, 0);
            const mfChannel = extractConversationLabel(messages);
            const mfAgent = extractAgentName(messages);
            logEntry.channel = mfChannel ? mfChannel.replace(/^Guild\s+/, '').slice(0, 30) : null;
            logEntry.agent = mfAgent || null;
            console.log(`[${requestId}] MEMORY FLUSH intercepted: tools=0 channel="${mfChannel}" agent="${mfAgent}" promptLen≈${promptLen}, returning NO_REPLY`);
            logEntry.status = 'ok';
            logEntry.resumeMethod = 'memflush';
            logEntry.promptLen = promptLen;
            logEntry.durationMs = Date.now() - startTime;
            pushActivity(requestId, `🧹 memflush intercepted (${Math.round(promptLen/1000)}K chars)`);
            return res.json({
                id: `chatcmpl-${requestId}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, message: { role: 'assistant', content: 'NO_REPLY' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            });
        }

        // Session title slug interception (must run before session routing)
        if (isSessionTitleSlugRequest(messages)) {
            const promptLen = messages.reduce((s: number, m: Message) => s + messageText(m).length, 0);
            console.warn(`[${requestId}] SESSION TITLE intercepted: tools=${tools.length} promptLen≈${promptLen}, returning NO_REPLY without session routing`);
            logEntry.status = 'ok';
            logEntry.resumeMethod = 'session_title_intercept';
            logEntry.promptLen = promptLen;
            logEntry.durationMs = Date.now() - startTime;
            pushActivity(requestId, '🏷️ session title intercepted');
            return res.json({
                id: `chatcmpl-${requestId}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, message: { role: 'assistant', content: 'NO_REPLY' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            });
        }

        // OC /new startup interception
        if (messages.length <= 4 && !extractConversationLabel(messages) &&
            messages.some((m: any) => {
                const c = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('') : '';
                return c.includes('New session started');
            })) {
            const nsAgent = extractAgentName(messages);
            logEntry.agent = nsAgent || null;
            console.log(`[${requestId}] OC /new startup intercepted (${messages.length} msgs, agent="${nsAgent}"), returning NO_REPLY`);
            logEntry.status = 'ok';
            logEntry.resumeMethod = 'newstart';
            logEntry.promptLen = 0;
            logEntry.durationMs = Date.now() - startTime;
            return res.json({
                id: `chatcmpl-${requestId}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, message: { role: 'assistant', content: 'NO_REPLY' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            });
        }
        // --- Session reuse detection ---
        gcMemory();
        let isResume = false;
        let resumeSessionId: string | null = null;

        // Extract OC conversation identity + agent name
        const convLabel = extractConversationLabel(messages);
        const agentName = extractAgentName(messages);
        const routingKey = convLabel
            ? (agentName ? `${convLabel}::${agentName}` : convLabel)
            : null;
        if (routingKey) {
            console.log(`[${requestId}] OC channel: "${convLabel}" agent: "${agentName || '(none)'}" routingKey: "${routingKey}"`);
        }

        // --- Per-channel and global concurrent limits ---
        if (stats.activeRequests > MAX_GLOBAL) {
            console.warn(`[${requestId}] BLOCKED: global limit (${MAX_GLOBAL} concurrent)`);
            logEntry.status = 'error';
            logEntry.error = 'Global concurrent limit';
            return res.status(429).json({ error: { message: `Too many concurrent requests (max ${MAX_GLOBAL})`, type: 'rate_limit' } });
        }
        if (routingKey) {
            releaseChannelLock = await acquireChannelLock(routingKey);
            channelActive.set(routingKey, (channelActive.get(routingKey) || 0) + 1);
            acquiredChannel = routingKey;
            console.log(`[${requestId}] channel lock acquired: "${routingKey}"`);
        }

        // 1) Check channelMap (primary: OC conversation → CLI session)
        if (!isResume && routingKey && channelMap.has(routingKey)) {
            resumeSessionId = channelMap.get(routingKey)!.sessionId;
            isResume = true;
            console.log(`[${requestId}] channelMap hit: "${routingKey}" → session=${resumeSessionId.slice(0, 8)}`);
        }
        // Detect /new after channelMap hit
        if (isResume && routingKey && channelMap.has(routingKey)) {
            const assistantMsgs = messages.filter((m: any) => m.role === 'assistant');
            if (assistantMsgs.length === 1) {
                const c = typeof assistantMsgs[0].content === 'string' ? assistantMsgs[0].content
                    : Array.isArray(assistantMsgs[0].content) ? assistantMsgs[0].content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('') : '';
                if (c.includes('New session started')) {
                    console.log(`[${requestId}] /new detected after channelMap hit: purging old session=${resumeSessionId!.slice(0, 8)}`);
                    purgeCliSession(resumeSessionId!);
                    channelMap.delete(routingKey);
                    isResume = false;
                    resumeSessionId = null;
                }
            }
        }
        // 2) Check tool_call_ids (tool loop continuation)
        if (!isResume) {
            for (const msg of messages) {
                if (msg.role === 'tool' && msg.tool_call_id && sessionMap.has(msg.tool_call_id)) {
                    resumeSessionId = sessionMap.get(msg.tool_call_id)!.sessionId;
                    isResume = true;
                    break;
                }
            }
        }
        // 3) Check assistant response content (fallback for DMs or missing label)
        if (!isResume) {
            for (const msg of messages) {
                if (msg.role === 'assistant') {
                    let text = msg.content;
                    if (Array.isArray(text)) {
                        text = text.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
                    }
                    const key = contentKey(typeof text === 'string' ? text : null);
                    if (key && responseMap.has(key)) {
                        resumeSessionId = responseMap.get(key)!.sessionId;
                        isResume = true;
                        console.log(`[${requestId}] responseMap hit: key="${key.slice(0, 50)}..." → session=${resumeSessionId.slice(0, 8)}`);
                        break;
                    }
                }
            }
            if (!isResume && messages.some((m: any) => m.role === 'assistant')) {
                const assistantKeys = messages.filter((m: any) => m.role === 'assistant').map((m: any) => {
                    let t = m.content;
                    if (Array.isArray(t)) t = t.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
                    return contentKey(typeof t === 'string' ? t : null);
                }).filter(Boolean);
                console.log(`[${requestId}] responseMap miss: tried ${assistantKeys.length} keys, map size=${responseMap.size}`);
                if (assistantKeys.length > 0) console.log(`[${requestId}]   first key: "${assistantKeys[0].slice(0, 60)}..."`);
            }
        }

        // Context refresh: detect OC compaction via summary hash → sync CLI
        if (isResume && routingKey && channelMap.has(routingKey)) {
            const COMPACTION_PREFIX = 'The conversation history before this point was compacted into the following summary:';
            let compactionHash: number | null = null;
            for (const m of messages) {
                if (m.role !== 'user') continue;
                const text = typeof m.content === 'string' ? m.content
                    : Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text || '').join('') : '';
                if (text.startsWith(COMPACTION_PREFIX)) {
                    const snippet = text.slice(0, 500);
                    let h = 0;
                    for (let i = 0; i < snippet.length; i++) { h = ((h << 5) - h + snippet.charCodeAt(i)) | 0; }
                    compactionHash = h;
                    break;
                }
            }

            const entry = channelMap.get(routingKey)!;
            const lastHash = entry?.lastCompactionHash ?? null;

            if (compactionHash !== null && compactionHash !== lastHash) {
                const inToolLoop = extractNewMessages(messages) !== null;
                if (!inToolLoop) {
                    const compactResult = convertMessagesCompact(messages);
                    if (compactResult.promptText.length > MAX_NEW_SESSION_CHARS) {
                        console.log(`[${requestId}] REFRESH SKIPPED: compact prompt too long (${compactResult.promptText.length})`);
                    } else {
                        const oldSid = entry.sessionId;
                        console.log(`[${requestId}] CONTEXT REFRESH (hash=${compactionHash}): ${oldSid.slice(0, 8)} → new session (compact ${compactResult.promptText.length} chars)`);
                        logEntry.resumeMethod = 'refresh';
                        logEntry.refreshPrompt = compactResult.promptText;
                        logEntry.refreshSystemPrompt = compactResult.systemPrompt;
                        logEntry.pendingCompactionHash = compactionHash;
                        purgeCliSession(oldSid);
                        channelMap.delete(routingKey);
                        isResume = false;
                        resumeSessionId = null;
                    }
                } else {
                    console.log(`[${requestId}] REFRESH DEFERRED: tool loop in progress (hash=${compactionHash})`);
                }
            }
        }
        let promptText: string;
        let combinedSystemPrompt: string | undefined;
        let sessionId: string;

        // Always build system prompt (not persisted in CLI session)
        const { systemPrompt: devSystemPrompt } = convertMessages(messages);
        const filteredTools = filterToolsByProfile(tools, messages);
        const toolInstructions = buildToolInstructions(filteredTools);
        if (filteredTools.length !== tools.length) {
            const kept = filteredTools.map((t: any) => t.function?.name || t.name).join(',');
            const dropped = tools.filter((t: any) => !filteredTools.includes(t)).map((t: any) => t.function?.name || t.name).join(',');
            console.log(`[${requestId}] tool profile: ${filteredTools.length}/${tools.length} kept=[${kept}] dropped=[${dropped}]`);
        }
        combinedSystemPrompt = devSystemPrompt
            ? `${devSystemPrompt}${toolInstructions}`
            : toolInstructions || undefined;

        if (isResume) {
            sessionId = resumeSessionId!;
            const newText = extractNewMessages(messages);
            const newUserText = !newText ? extractNewUserMessages(messages) : null;
            if (newText) {
                promptText = newText;
                logEntry.resumeMethod = 'tool_loop';
                console.log(`[${requestId}] RESUME session=${sessionId.slice(0, 8)} newPromptLen=${promptText.length} (tool loop)`);
                pushActivity(requestId, `🔄 resuming session (${promptText.length} chars new)`);
            } else if (newUserText) {
                promptText = newUserText;
                logEntry.resumeMethod = 'continuation';
                console.log(`[${requestId}] RESUME session=${sessionId.slice(0, 8)} newPromptLen=${promptText.length} (continuation)`);
                pushActivity(requestId, `🔄 resuming session (${promptText.length} chars new)`);
            } else {
                logEntry.resumeMethod = 'fallback';
                purgeCliSession(sessionId);
                if (routingKey) channelMap.delete(routingKey);
                isResume = false;
                sessionId = uuidv4();
                promptText = convertMessages(messages).promptText;
                console.log(`[${requestId}] RESUME fallback → new session=${sessionId.slice(0, 8)}`);
                pushActivity(requestId, `⏳ thinking... (${tools.length} tools) [resume fallback]`);
            }
        } else {
            sessionId = uuidv4();
            if (logEntry.refreshPrompt) {
                promptText = logEntry.refreshPrompt;
                const refreshSys = logEntry.refreshSystemPrompt;
                if (refreshSys) {
                    combinedSystemPrompt = `${refreshSys}${toolInstructions}`;
                }
                delete logEntry.refreshPrompt;
                delete logEntry.refreshSystemPrompt;
                console.log(`[${requestId}] NEW session=${sessionId.slice(0, 8)} (context refresh)`);
                pushActivity(requestId, `🔄 context refresh → new session (${promptText.length} chars)`);
            } else {
                promptText = convertMessages(messages).promptText;
                console.log(`[${requestId}] NEW session=${sessionId.slice(0, 8)}`);
                pushActivity(requestId, `⏳ thinking... (${tools.length} tools)`);
            }
        }

        // Guard: if prompt is too large for new session, compact it
        if (!isResume && promptText.length > MAX_NEW_SESSION_CHARS) {
            console.warn(`[${requestId}] Prompt too large (${promptText.length} chars), auto-compacting`);
            const compactResult = convertMessagesCompact(messages);
            promptText = compactResult.promptText;
            if (compactResult.systemPrompt) {
                combinedSystemPrompt = `${compactResult.systemPrompt}${toolInstructions}`;
            }
            console.log(`[${requestId}] Compacted: ${promptText.length} chars`);
        }

        logEntry.promptLen = promptText.length;
        logEntry.cliSessionId = sessionId.slice(0, 8);
        logEntry.resumed = isResume;
        logEntry.channel = convLabel ? convLabel.replace(/^Guild\s+/, '').slice(0, 30) : null;
        logEntry.agent = agentName || null;
        console.log(`[${requestId}] model=${model} tools=${tools.length} promptLen=${promptText.length} resume=${isResume}`);

        const isStream = stream !== false;
        if (isStream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders();
            keepaliveTimer = setInterval(() => {
                try {
                    const heartbeat = JSON.stringify({
                        id: `chatcmpl-${requestId}`, object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000), model,
                        choices: [],
                    });
                    res.write(`data: ${heartbeat}\n\n`);
                } catch {}
            }, 15000);
        }

        const completionId = `chatcmpl-${requestId}`;
        let chunksSent = 0;
        let accumulatedText = '';

        const sendChunk = (delta: string, finishReason: string | null = null) => {
            const chunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: finishReason ? {} : { role: 'assistant', content: delta }, finish_reason: finishReason }],
            };
            if (isStream) { res.write(`data: ${JSON.stringify(chunk)}\n\n`); chunksSent++; }
        };

        // Stream reasoning/thinking blocks as OpenAI-compatible reasoning_content deltas
        const sendReasoningChunk = (text: string) => {
            const chunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
            };
            if (isStream) { res.write(`data: ${JSON.stringify(chunk)}\n\n`); }
        };

        const onChunk = (text: string) => {
            const msg = text.trim();
            if (!msg) return;
            console.log(`[${requestId}] ${msg}`);
            logEntry.activity.push(msg);
            pushActivity(requestId, msg);
        };

        // Reasoning callback — stream thinking blocks and log snippets
        const onReasoning = (text: string) => {
            sendReasoningChunk(text);
            const snippet = text.length > 80 ? text.slice(0, 80) + '…' : text;
            pushActivity(requestId, `🧠 reasoning: ${snippet}`);
        };

        // Skip reasoning override for models that don't support it (e.g. Haiku)
        const isReasoningModel = !model.toLowerCase().includes('haiku');
        const effectiveReasoningEffort = isReasoningModel ? reasoning_effort : undefined;

        const ac = new AbortController();
        res.on('close', () => { if (!res.writableFinished) ac.abort(); });

        let finalText: string | undefined;
        let finalUsage: { input_tokens: number; cache_creation_tokens: number; cache_read_tokens: number; output_tokens: number; cost_usd: number } = { input_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, output_tokens: 0, cost_usd: 0 };
        try {
            const result = await runClaude(combinedSystemPrompt, promptText, model, onChunk, ac.signal, effectiveReasoningEffort, sessionId, isResume, onReasoning);
            finalText = result.text;
            finalUsage = { input_tokens: result.usage.input_tokens || 0, cache_creation_tokens: result.usage.cache_creation_tokens || 0, cache_read_tokens: result.usage.cache_read_tokens || 0, output_tokens: result.usage.output_tokens || 0, cost_usd: result.usage.cost_usd || 0 };
        } catch (err: any) {
            // OC disconnected (timeout/restart) — not a CLI error, preserve session
            if (isResume && err.message === 'Client disconnected') {
                console.log(`[${requestId}] OC disconnected, preserving session=${sessionId.slice(0, 8)}`);
                stats.errors++;
                logEntry.status = 'oc_disconnect';
                logEntry.error = err.message;
                logEntry.durationMs = Date.now() - startTime;
                return;
            }
            // Classify timeout errors
            if (err.message && err.message.includes('Idle timeout')) {
                stats.errors++;
                logEntry.status = 'idle_timeout';
                logEntry.error = err.message;
            } else if (err.message && err.message.includes('Hard timeout')) {
                stats.errors++;
                logEntry.status = 'hard_timeout';
                logEntry.error = err.message;
            }
            // CLI failed — retry with compact history
            if (isResume) {
                console.warn(`[${requestId}] CLI failed (${err.message}), retrying with compact refresh`);
                pushActivity(requestId, `⚠ CLI failed, retrying with compact refresh`);
                logEntry.activity.push(`⚠ CLI failed: ${err.message}`);
                purgeCliSession(sessionId);
                if (routingKey) channelMap.delete(routingKey);
                isResume = false;
                sessionId = uuidv4();
                logEntry.resumeMethod = 'refresh';
                const compactResult = convertMessagesCompact(messages);
                promptText = compactResult.promptText;
                if (compactResult.systemPrompt) {
                    combinedSystemPrompt = `${compactResult.systemPrompt}${toolInstructions}`;
                }
                if (promptText.length > MAX_NEW_SESSION_CHARS) {
                    console.warn(`[${requestId}] Compact retry still too large (${promptText.length}), truncating`);
                    promptText = promptText.slice(-MAX_NEW_SESSION_CHARS);
                }
                logEntry.promptLen = promptText.length;
                console.log(`[${requestId}] Compact refresh: new session=${sessionId.slice(0, 8)} promptLen=${promptText.length}`);
                try {
                    const retryResult = await runClaude(combinedSystemPrompt, promptText, model, onChunk, ac.signal, effectiveReasoningEffort, sessionId, false, onReasoning);
                    finalText = retryResult.text;
                    finalUsage = { input_tokens: retryResult.usage.input_tokens || 0, cache_creation_tokens: retryResult.usage.cache_creation_tokens || 0, cache_read_tokens: retryResult.usage.cache_read_tokens || 0, output_tokens: retryResult.usage.output_tokens || 0, cost_usd: retryResult.usage.cost_usd || 0 };
                } catch (retryErr: any) {
                    console.error(`[${requestId}] Retry also failed: ${retryErr.message}`);
                    stats.errors++;
                    logEntry.status = 'error';
                    logEntry.error = retryErr.message;
                    if (isStream) {
                        sendChunk(`\n\n[Error: ${retryErr.message}]`);
                        sendChunk('', 'stop');
                        res.write('data: [DONE]\n\n');
                        res.end();
                    } else {
                        res.status(500).json({ error: { message: retryErr.message, type: 'internal_error' } });
                    }
                    return;
                }
            } else {
                console.error(`[${requestId}] Claude error: ${err.message}`);
                stats.errors++;
                logEntry.status = err.message.includes('exited with code') ? 'cli_exit' : 'error';
                logEntry.error = err.message;
                if (isStream) {
                    sendChunk(`\n\n[Error: ${err.message}]`);
                    sendChunk('', 'stop');
                    res.write('data: [DONE]\n\n');
                    res.end();
                } else {
                    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
                }
                return;
            }
        }

        logEntry.inputTokens = finalUsage.input_tokens;
        logEntry.cacheWriteTokens = finalUsage.cache_creation_tokens;
        logEntry.cacheReadTokens = finalUsage.cache_read_tokens;
        logEntry.outputTokens = finalUsage.output_tokens;
        logEntry.costUsd = finalUsage.cost_usd;
        const hasUsage = (finalUsage.input_tokens || 0) + (finalUsage.cache_creation_tokens || 0) + (finalUsage.output_tokens || 0) > 0;
        logEntry.usageAvailable = hasUsage;

        const totalInput = (finalUsage.input_tokens || 0) + (finalUsage.cache_creation_tokens || 0) + (finalUsage.cache_read_tokens || 0);
        const usagePayload = {
            prompt_tokens:     totalInput,
            completion_tokens: finalUsage.output_tokens,
            total_tokens:      totalInput + finalUsage.output_tokens,
            prompt_tokens_details: {
                cached_tokens: finalUsage.cache_read_tokens,
                cache_creation_tokens: finalUsage.cache_creation_tokens,
            },
        };

        // Parse <tool_call> blocks from Claude's response
        const parsedToolCalls = parseToolCalls(finalText || '');
        const availableToolNames = getAvailableToolNames(tools);
        const { invalid: invalidToolCalls } = filterToolCalls(parsedToolCalls, availableToolNames);
        if (invalidToolCalls.length > 0) {
            // Forward invalid tool_calls instead of dropping them: the orchestrator will
            // surface tool_not_found and the model can self-correct on the next turn.
            // Dropping silently caused empty responses when the model hallucinated names
            // (e.g. "discord" instead of "message"), losing the user-facing message.
            const names = invalidToolCalls.map((tc: ToolCallType) => tc.name).join(', ');
            console.warn(`[${requestId}] forwarding unknown tool_calls (will surface as tool_not_found): [${names}]`);
            pushActivity(requestId, `forwarding unknown tool_calls: [${names}]`);
            logEntry.activity.push(`forwarding unknown tool_calls: [${names}]`);
        }
        const toolCalls = parsedToolCalls;
        if (toolCalls.length > 0) {
            const textBeforeTools = cleanResponseText(finalText || '');
            const toolNames = toolCalls.map((tc: ToolCallType) => tc.name).join(', ');
            console.log(`[${requestId}] → tool_calls: [${toolNames}]`);
            pushActivity(requestId, `→ tool_calls: [${toolNames}]`);
            logEntry.activity.push(`→ tool_calls: [${toolNames}]`);

            // Track tool_call_ids for session reuse
            for (const tc of toolCalls) {
                sessionMap.set(tc.id, { sessionId, createdAt: Date.now() });
            }
            console.log(`[${requestId}] sessionMap: stored ${toolCalls.length} tool_call_ids for session=${sessionId.slice(0, 8)} (total=${sessionMap.size})`);

            if (isStream) {
                // Send tool_calls delta
                const tcDelta = {
                    id: completionId, object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, delta: {
                        tool_calls: toolCalls.map((tc: ToolCallType, i: number) => ({
                            index: i,
                            id: tc.id,
                            type: 'function',
                            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                        })),
                    }, finish_reason: null }],
                };
                res.write(`data: ${JSON.stringify(tcDelta)}\n\n`);

                const stopChunk = {
                    id: completionId, object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                };
                res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
                const usageChunk = {
                    id: completionId, object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [],
                    usage: usagePayload,
                };
                res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            } else {
                res.json({
                    id: completionId, object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: toolCalls.map((tc: ToolCallType, i: number) => ({
                            id: tc.id, index: i, type: 'function',
                            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                        })),
                    }, finish_reason: 'tool_calls' }],
                    usage: usagePayload,
                });
            }
        } else {
            // No tool calls — return clean text with finish_reason: stop.
            // Fail closed if raw bridge markup somehow survives parsing.
            let cleanText = cleanResponseText(finalText);
            if (hasInternalBridgeMarkup(finalText || '')) {
                console.warn(`[${requestId}] WARNING suppressed_internal_bridge_markup preview=${redactSensitivePreview(finalText || '')}`);
                pushActivity(requestId, '⚠ suppressed bridge markup leak');
                logEntry.activity.push('⚠ suppressed bridge markup leak');
                cleanText = '';
            }
            if (cleanText) sendChunk(cleanText);

            if (isStream) {
                const stopChunk = {
                    id: completionId, object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                };
                res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
                const usageChunk = {
                    id: completionId, object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [],
                    usage: usagePayload,
                };
                res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            } else {
                res.json({
                    id: completionId, object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, message: { role: 'assistant', content: cleanText || '' }, finish_reason: 'stop' }],
                    usage: usagePayload,
                });
            }
        }

        // Store channel → CLI session mapping
        if (routingKey) {
            const prevEntry = channelMap.get(routingKey);
            channelMap.set(routingKey, {
                sessionId,
                createdAt: Date.now(),
                lastCompactionHash: logEntry.pendingCompactionHash ?? prevEntry?.lastCompactionHash ?? null,
            });
            if (logEntry.pendingCompactionHash) delete logEntry.pendingCompactionHash;
            console.log(`[${requestId}] channelMap stored: "${routingKey}" → session=${sessionId.slice(0, 8)} (map size=${channelMap.size})`);
        }

        const cleanedForMap = cleanResponseText(finalText);
        const rKey = contentKey(cleanedForMap);
        if (rKey) {
            responseMap.set(rKey, { sessionId, createdAt: Date.now() });
        }

        logEntry.status = 'ok';
        const elapsed = Date.now() - startTime;
        logEntry.durationMs = elapsed;
        console.log(`[${requestId}] done ${elapsed}ms chunks=${chunksSent}`);
        pushActivity(requestId, `✓ done ${(elapsed / 1000).toFixed(1)}s`);

    } catch (err: any) {
        stats.errors++;
        logEntry.status = 'error';
        logEntry.error = err.message;
        console.error(`[${requestId}] Unhandled:`, err);
        if (!res.headersSent) res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
        else res.end();
    } finally {
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        if (releaseChannelLock) releaseChannelLock();
        stats.activeRequests = Math.max(0, stats.activeRequests - 1);
        if (acquiredChannel) {
            const cnt = channelActive.get(acquiredChannel) || 0;
            if (cnt <= 1) channelActive.delete(acquiredChannel);
            else channelActive.set(acquiredChannel, cnt - 1);
        }
        logEntry.durationMs = logEntry.durationMs ?? (Date.now() - startTime);
        saveState();
    }
});
// ─── Status app (port 3458, all interfaces) ───────────────────────────────────
const statusApp = express();

statusApp.use(express.json());

// Dashboard password protection (Basic Auth)
const DASHBOARD_PASS = process.env.DASHBOARD_PASS;
if (DASHBOARD_PASS) {
    const expected = 'Basic ' + Buffer.from('admin:' + DASHBOARD_PASS).toString('base64');
    statusApp.use((req: Request, res: Response, next) => {
        if (req.headers.authorization === expected) return next();
        res.setHeader('WWW-Authenticate', 'Basic realm="Dashboard"');
        res.status(401).send('Unauthorized');
    });
}

// Serve React dashboard (built files)
statusApp.use(express.static(path.join(__dirname, '../dashboard/dist')));

statusApp.get('/status', (_req: Request, res: Response) => {
    res.json({
        status: 'running',
        uptime: Math.floor((Date.now() - stats.startedAt.getTime()) / 1000),
        startedAt: stats.startedAt,
        totalRequests: stats.totalRequests,
        activeRequests: stats.activeRequests,
        lastRequestAt: stats.lastRequestAt,
        lastModel: stats.lastModel,
        errors: stats.errors,
        sessions: getSessionInfo(),
        channels: Array.from(channelMap.entries()).map(([label, val]) => ({
            label: label.replace(/^Guild\s+/, '').slice(0, 40),
            sessionId: val.sessionId.slice(0, 8),
            age: Math.floor((Date.now() - val.createdAt) / 1000),
        })),
        contextWindows: {
            'claude-opus-latest': getContextWindow('claude-opus-latest'),
            'claude-sonnet-latest': getContextWindow('claude-sonnet-latest'),
            'claude-haiku-latest': getContextWindow('claude-haiku-latest'),
        },
        activity: globalActivity.slice(-30),
        log: [...requestLog].reverse(),
    });
});

statusApp.post('/cleanup', (_req: Request, res: Response) => {
    const result = cleanupSessions();
    console.log(`[openclaw-claude-bridge] Manual cleanup: deleted ${result.deleted}, remaining ${result.remaining}`);
    res.json(result);
});

// SPA fallback — serve index.html for any non-API route
statusApp.get('*', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, '../dashboard/dist/index.html'));
});

export { app, statusApp, stats, saveState };
