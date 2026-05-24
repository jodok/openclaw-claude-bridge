'use strict';

import type { Message, ContentPart } from './tools';

// Sentinel markers that delimit regions of promptText which must NOT be
// brand-substituted. Tool-call JSON arguments and tool-result payloads contain
// literal data the orchestrator owns — filesystem paths, command output,
// identifiers — that round-trips back from Claude to OpenClaw. Substituting
// `OpenClaw → alias` inside those regions silently corrupts on-disk reality
// (e.g. `ls /Users/x/.openclaw/...` becomes `ls /Users/x/.<alias>/...`).
// Markers are built from control char codes so they themselves can never be
// substituted by the brand pass.
export const NOSCRUB_OPEN = String.fromCharCode(0x1E) + 'NOSCRUB' + String.fromCharCode(0x1F);
export const NOSCRUB_CLOSE = String.fromCharCode(0x1F) + 'NOSCRUB' + String.fromCharCode(0x1E);
function noscrub(text: string): string {
    return NOSCRUB_OPEN + text + NOSCRUB_CLOSE;
}

export interface ConvertedMessages {
    systemPrompt: string;
    promptText: string;
}

export interface CompactOptions {
    assistantCap?: number;
    recentToolCap?: number;
    oldToolCap?: number;
    recentTurns?: number;
}

export interface ExtractOptions {
    toolResultCap?: number;
}

/**
 * Convert an OpenAI messages array into:
 *   - systemPrompt: string (from developer/system roles)
 *   - promptText: string (conversation + user message for stdin)
 *
 * Handles the full OpenAI message format including tool_calls and tool results
 * so Claude can see the complete conversation history.
 */
export function convertMessages(messages: Message[]): ConvertedMessages {
    const systemParts: string[] = [];
    const conversationParts: string[] = [];

    for (const msg of messages) {
        const role = msg.role;
        const content = extractContent(msg.content);

        if (role === 'developer' || role === 'system') {
            systemParts.push(content);
        } else if (role === 'user') {
            conversationParts.push(`User: ${content}`);
        } else if (role === 'assistant') {
            // Include both text content and any tool_calls from history
            const parts: string[] = [];
            if (content) parts.push(content);

            // Include tool_calls so Claude knows what was previously requested
            if (Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls) {
                    const fn = tc.function || {};
                    parts.push(noscrub(`<tool_call>\n{"name": "${fn.name}", "arguments": ${fn.arguments || '{}'}}\n</tool_call>`));
                }
            }

            if (parts.length > 0) {
                conversationParts.push(`<previous_response>\n${parts.join('\n')}\n</previous_response>`);
            }
        } else if (role === 'tool') {
            // Tool results from OC's execution — include so Claude can use them
            const toolName = msg.name || '';
            const toolId = msg.tool_call_id || '';
            if (content) {
                conversationParts.push(noscrub(`<tool_result name="${toolName}" tool_call_id="${toolId}">\n${content}\n</tool_result>`));
            }
        }
    }

    return {
        systemPrompt: systemParts.join('\n\n'),
        promptText: conversationParts.join('\n\n'),
    };
}

/**
 * Extract plain text from a content field (string or array of parts).
 */
export function extractContent(content: string | ContentPart[] | null | undefined): string {
    if (typeof content === 'string') return content;
    if (content === null || content === undefined) return '';
    if (Array.isArray(content)) {
        return content
            .filter((p: ContentPart) => p.type === 'text')
            .map((p: ContentPart) => p.text)
            .join('\n');
    }
    return String(content ?? '');
}

/**
 * Extract only the new messages after the last assistant tool_calls message.
 * Used for --resume mode (tool loop) to avoid re-sending the full conversation history.
 * Returns formatted text string, or null if no tool_calls found.
 */
export function extractNewMessages(messages: Message[], opts: ExtractOptions = {}): string | null {
    const { toolResultCap = 15000 } = opts;
    // Find the last assistant message with tool_calls (from the tail)
    let lastToolCallIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            lastToolCallIdx = i;
            break;
        }
    }
    if (lastToolCallIdx === -1) return null;

    // If there's a text-only assistant AFTER the last tool_call assistant,
    // the tool loop is over. Return null to fall through to extractNewUserMessages().
    for (let i = lastToolCallIdx + 1; i < messages.length; i++) {
        const m = messages[i];
        if (m && m.role === 'assistant') {
            return null;  // Tool loop ended — use extractNewUserMessages() instead
        }
    }

    // Only take messages after the last assistant tool_calls
    const newMessages = messages.slice(lastToolCallIdx + 1);
    const parts: string[] = [];
    for (const msg of newMessages) {
        if (msg.role === 'tool') {
            const toolName = msg.name || '';
            const toolId = msg.tool_call_id || '';
            let content = extractContent(msg.content);
            if (content) {
                if (content.length > toolResultCap) {
                    content = content.slice(0, toolResultCap) + '\n[... truncated]';
                }
                parts.push(noscrub(`<tool_result name="${toolName}" tool_call_id="${toolId}">\n${content}\n</tool_result>`));
            }
        } else if (msg.role === 'user') {
            parts.push(`User: ${extractContent(msg.content)}`);
        }
    }
    return parts.join('\n\n');
}

/**
 * Extract messages after the last assistant message (regardless of tool_calls).
 * Used for --resume mode when the conversation has no tool_calls (simple continuation).
 * Returns formatted text string, or null if nothing new found.
 */
export function extractNewUserMessages(messages: Message[], opts: ExtractOptions = {}): string | null {
    const { toolResultCap = 15000 } = opts;
    // Find the last assistant message (from the tail)
    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'assistant') {
            lastAssistantIdx = i;
            break;
        }
    }
    if (lastAssistantIdx === -1) return null;

    // Only take messages after the last assistant message
    const newMessages = messages.slice(lastAssistantIdx + 1);
    if (newMessages.length === 0) return null;

    const parts: string[] = [];
    for (const msg of newMessages) {
        if (msg.role === 'user') {
            const content = extractContent(msg.content);
            if (content) parts.push(content);
        } else if (msg.role === 'tool') {
            const toolName = msg.name || '';
            const toolId = msg.tool_call_id || '';
            let content = extractContent(msg.content);
            if (content) {
                if (content.length > toolResultCap) {
                    content = content.slice(0, toolResultCap) + '\n[... truncated]';
                }
                parts.push(noscrub(`<tool_result name="${toolName}" tool_call_id="${toolId}">\n${content}\n</tool_result>`));
            }
        }
    }
    return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * Compact version of convertMessages for context refresh.
 * Truncates assistant text and tool results to reduce prompt size.
 */
export function convertMessagesCompact(messages: Message[], opts: CompactOptions = {}): ConvertedMessages {
    const {
        assistantCap = 1500,
        recentToolCap = 2000,
        oldToolCap = 500,
        recentTurns = 10,
    } = opts;

    const systemParts: string[] = [];
    const conversationParts: string[] = [];

    // Count user turns to determine recent vs old
    let userTurnCount = 0;
    for (const msg of messages) {
        if (msg.role === 'user') userTurnCount++;
    }
    const recentCutoff = Math.max(0, userTurnCount - recentTurns);

    let currentUserTurn = 0;
    for (const msg of messages) {
        const role = msg.role;
        const content = extractContent(msg.content);

        if (role === 'developer' || role === 'system') {
            systemParts.push(content);
        } else if (role === 'user') {
            currentUserTurn++;
            conversationParts.push(`User: ${content}`);
        } else if (role === 'assistant') {
            const parts: string[] = [];
            if (content) {
                if (content.length > assistantCap) {
                    parts.push(content.slice(0, assistantCap) + '\n[... truncated]');
                } else {
                    parts.push(content);
                }
            }
            if (Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls) {
                    const fn = tc.function || {};
                    parts.push(noscrub(`<tool_call>\n{"name": "${fn.name}", "arguments": ${fn.arguments || '{}'}}\n</tool_call>`));
                }
            }
            if (parts.length > 0) {
                conversationParts.push(`<previous_response>\n${parts.join('\n')}\n</previous_response>`);
            }
        } else if (role === 'tool') {
            const toolName = msg.name || '';
            const toolId = msg.tool_call_id || '';
            if (content) {
                const cap = currentUserTurn >= recentCutoff ? recentToolCap : oldToolCap;
                const truncated = content.length > cap ? content.slice(0, cap) + '\n[... truncated]' : content;
                conversationParts.push(noscrub(`<tool_result name="${toolName}" tool_call_id="${toolId}">\n${truncated}\n</tool_result>`));
            }
        }
    }

    return {
        systemPrompt: systemParts.join('\n\n'),
        promptText: conversationParts.join('\n\n'),
    };
}
