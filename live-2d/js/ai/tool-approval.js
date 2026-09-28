// tool-approval.js - asks the user before the AI runs a tool that can change the PC.
//
// Every tool call (MCP servers and plugins) goes through ToolExecutor, and ToolExecutor
// asks this module first. The rules live in live-2d/tool_safety.json:
//   auto_approve - tools that run without asking (keep this to read-only tools)
//   always_ask   - tools that ask every time ("Allow for this session" is not offered)
//   blocked      - tools that never run
// Every other tool asks. Plugin tools are listed by name ("click_mouse").
// MCP tools are listed as "mcp:<server>/<tool>" ("mcp:windows-mcp/Click"),
// and "mcp:<server>/*" matches every tool of that server.
const fs = require('fs');
const path = require('path');

const POLICY_PATH = path.join(__dirname, '..', '..', 'tool_safety.json');

// Used when tool_safety.json is missing or broken, so the gate never fails open.
const DEFAULT_POLICY = Object.freeze({
    enabled: true,
    timeout_seconds: 120,
    auto_approve: [],
    always_ask: [],
    blocked: []
});

const MAX_ARGS_CHARS = 1500;

function toStringList(value) {
    return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : [];
}

function normalizePolicy(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const timeout = Number(source.timeout_seconds);
    return {
        enabled: source.enabled !== false,
        timeout_seconds: Number.isFinite(timeout) && timeout >= 0 ? timeout : DEFAULT_POLICY.timeout_seconds,
        auto_approve: toStringList(source.auto_approve),
        always_ask: toStringList(source.always_ask),
        blocked: toStringList(source.blocked)
    };
}

function matchesRule(toolId, rules) {
    return rules.some(rule => {
        if (rule === toolId) return true;
        return rule.endsWith('/*') && toolId.startsWith(rule.slice(0, -1));
    });
}

function formatArgs(args) {
    let text;
    try {
        text = JSON.stringify(args ?? {}, null, 2);
    } catch (error) {
        text = String(args);
    }
    if (text.length > MAX_ARGS_CHARS) {
        text = `${text.slice(0, MAX_ARGS_CHARS)}\n... (${text.length - MAX_ARGS_CHARS} more characters)`;
    }
    return text;
}

// Default way to ask: a native dialog shown by the Electron main process
// (see js/services/tool-approval-dialog.js). Any failure counts as "deny".
async function askWithElectronDialog(request) {
    const { ipcRenderer } = require('electron');
    if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') {
        throw new Error('ipcRenderer is not available');
    }
    return ipcRenderer.invoke('tool-approval:ask', request);
}

class ToolApproval {
    /**
     * @param {object} [options]
     * @param {string} [options.policyPath] - path to tool_safety.json
     * @param {Function} [options.ask] - async (request) => 'deny' | 'once' | 'session'
     */
    constructor({ policyPath = POLICY_PATH, ask = askWithElectronDialog } = {}) {
        this.policyPath = policyPath;
        this.ask = ask;
        this.sessionAllowed = new Set();
    }

    // Read the policy on every call, so edits to tool_safety.json apply without a restart.
    getPolicy() {
        try {
            return normalizePolicy(JSON.parse(fs.readFileSync(this.policyPath, 'utf8')));
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.warn(`tool_safety.json could not be read, every tool will ask first: ${error.message}`);
            }
            return normalizePolicy(DEFAULT_POLICY);
        }
    }

    /**
     * Decide whether one tool call can run.
     * @param {{toolId: string, toolName: string, source: string}} tool
     * @param {object} args - tool arguments from the LLM
     * @returns {Promise<{allowed: boolean, reason: string}>}
     */
    async check(tool, args) {
        const policy = this.getPolicy();
        const { toolId } = tool;

        if (matchesRule(toolId, policy.blocked)) return { allowed: false, reason: 'blocked' };
        if (!policy.enabled) return { allowed: true, reason: 'gate-disabled' };
        if (matchesRule(toolId, policy.auto_approve)) return { allowed: true, reason: 'auto-approved' };
        if (this.sessionAllowed.has(toolId)) return { allowed: true, reason: 'allowed-this-session' };

        const canRemember = !matchesRule(toolId, policy.always_ask);
        let decision = 'deny';
        try {
            decision = await this.ask({
                toolId,
                toolName: tool.toolName,
                source: tool.source,
                argsText: formatArgs(args),
                canRemember,
                timeoutSeconds: policy.timeout_seconds
            });
        } catch (error) {
            console.warn(`Tool approval failed, denying ${toolId}: ${error.message}`);
            decision = 'deny';
        }

        if (decision === 'session' && canRemember) {
            this.sessionAllowed.add(toolId);
            return { allowed: true, reason: 'allowed-this-session' };
        }
        if (decision === 'once' || decision === 'session') return { allowed: true, reason: 'allowed-once' };
        return { allowed: false, reason: 'denied' };
    }

    /**
     * Same as check(), but returns null when the tool can run, or the tool result
     * text that tells the LLM why it did not run.
     */
    async denialFor(tool, args) {
        const { allowed, reason } = await this.check(tool, args);
        if (allowed) return null;
        if (reason === 'blocked') {
            return `Tool "${tool.toolName}" is blocked in tool_safety.json and did not run. Do not try it again.`;
        }
        return `The user did not allow the tool "${tool.toolName}" to run. Do not try it again unless the user asks for it.`;
    }
}

const toolApproval = new ToolApproval();

module.exports = { ToolApproval, toolApproval, matchesRule, normalizePolicy, DEFAULT_POLICY };
