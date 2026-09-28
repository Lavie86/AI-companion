'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ToolApproval, matchesRule, normalizePolicy } = require('./tool-approval.js');

const MCP_CLICK = { toolId: 'mcp:windows-mcp/Click', toolName: 'Click', source: 'MCP server "windows-mcp"' };
const MCP_SHELL = { toolId: 'mcp:windows-mcp/PowerShell', toolName: 'PowerShell', source: 'MCP server "windows-mcp"' };
const PLUGIN_SEARCH = { toolId: 'web_search', toolName: 'web_search', source: 'plugin' };

describe('matchesRule', () => {
    it('matches exact ids and server wildcards only', () => {
        assert.equal(matchesRule('web_search', ['web_search']), true);
        assert.equal(matchesRule('mcp:windows-mcp/Click', ['mcp:windows-mcp/*']), true);
        assert.equal(matchesRule('mcp:windows-mcp-evil/Click', ['mcp:windows-mcp/*']), false);
        assert.equal(matchesRule('web_search_extra', ['web_search']), false);
        assert.equal(matchesRule('Click', ['mcp:windows-mcp/Click']), false);
    });
});

describe('normalizePolicy', () => {
    it('keeps the gate on and fills safe defaults for bad input', () => {
        assert.deepEqual(normalizePolicy(null), {
            enabled: true, timeout_seconds: 120, auto_approve: [], always_ask: [], blocked: []
        });
        const policy = normalizePolicy({ enabled: 'no', timeout_seconds: -5, auto_approve: ['a', 3, ''], blocked: 'x' });
        assert.equal(policy.enabled, true);
        assert.equal(policy.timeout_seconds, 120);
        assert.deepEqual(policy.auto_approve, ['a']);
        assert.deepEqual(policy.blocked, []);
    });
});

describe('ToolApproval', () => {
    let dir;
    let policyPath;
    let asked;
    let answer;

    function makeApproval(policy) {
        if (policy !== undefined) {
            fs.writeFileSync(policyPath, typeof policy === 'string' ? policy : JSON.stringify(policy));
        }
        return new ToolApproval({
            policyPath,
            ask: async (request) => {
                asked.push(request);
                if (answer instanceof Error) throw answer;
                return answer;
            }
        });
    }

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-approval-'));
        policyPath = path.join(dir, 'tool_safety.json');
        asked = [];
        answer = 'deny';
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('runs auto-approved tools without asking', async () => {
        const approval = makeApproval({ auto_approve: ['web_search'] });
        assert.deepEqual(await approval.check(PLUGIN_SEARCH, {}), { allowed: true, reason: 'auto-approved' });
        assert.equal(asked.length, 0);
    });

    it('asks for other tools and denies by default', async () => {
        const approval = makeApproval({ auto_approve: ['web_search'], timeout_seconds: 30 });
        const result = await approval.check(MCP_CLICK, { loc: [10, 20] });
        assert.deepEqual(result, { allowed: false, reason: 'denied' });
        assert.equal(asked.length, 1);
        assert.equal(asked[0].toolId, 'mcp:windows-mcp/Click');
        assert.equal(asked[0].canRemember, true);
        assert.equal(asked[0].timeoutSeconds, 30);
        assert.match(asked[0].argsText, /"loc"/);
    });

    it('"Allow once" allows one call and asks again next time', async () => {
        answer = 'once';
        const approval = makeApproval({});
        assert.equal((await approval.check(MCP_CLICK, {})).allowed, true);
        assert.equal((await approval.check(MCP_CLICK, {})).allowed, true);
        assert.equal(asked.length, 2);
    });

    it('"Allow for this session" stops asking for that tool only', async () => {
        answer = 'session';
        const approval = makeApproval({});
        assert.equal((await approval.check(MCP_CLICK, {})).allowed, true);
        assert.deepEqual(await approval.check(MCP_CLICK, {}), { allowed: true, reason: 'allowed-this-session' });
        assert.equal(asked.length, 1);
        answer = 'deny';
        assert.equal((await approval.check(MCP_SHELL, {})).allowed, false);
        assert.equal(asked.length, 2);
    });

    it('always_ask tools cannot be remembered for the session', async () => {
        answer = 'session';
        const approval = makeApproval({ always_ask: ['mcp:windows-mcp/PowerShell'] });
        assert.deepEqual(await approval.check(MCP_SHELL, { command: 'dir' }), { allowed: true, reason: 'allowed-once' });
        assert.equal(asked[0].canRemember, false);
        await approval.check(MCP_SHELL, { command: 'dir' });
        assert.equal(asked.length, 2);
    });

    it('blocked tools never run, even with the gate turned off', async () => {
        answer = 'once';
        const approval = makeApproval({ enabled: false, blocked: ['mcp:windows-mcp/*'], auto_approve: ['mcp:windows-mcp/Click'] });
        assert.deepEqual(await approval.check(MCP_CLICK, {}), { allowed: false, reason: 'blocked' });
        assert.equal(asked.length, 0);
    });

    it('enabled: false runs every tool that is not blocked', async () => {
        const approval = makeApproval({ enabled: false });
        assert.deepEqual(await approval.check(MCP_SHELL, {}), { allowed: true, reason: 'gate-disabled' });
        assert.equal(asked.length, 0);
    });

    it('fails closed when the dialog fails', async () => {
        answer = new Error('no window');
        const approval = makeApproval({});
        assert.deepEqual(await approval.check(MCP_CLICK, {}), { allowed: false, reason: 'denied' });
    });

    it('asks for everything when the policy file is missing or broken', async () => {
        answer = 'deny';
        const missing = makeApproval();
        assert.equal((await missing.check(PLUGIN_SEARCH, {})).allowed, false);
        const broken = makeApproval('{ not json');
        assert.equal((await broken.check(PLUGIN_SEARCH, {})).allowed, false);
        assert.equal(asked.length, 2);
    });

    it('denies when there is no Electron IPC to ask with', async () => {
        fs.writeFileSync(policyPath, '{}');
        const approval = new ToolApproval({ policyPath });
        assert.deepEqual(await approval.check(MCP_CLICK, {}), { allowed: false, reason: 'denied' });
    });

    it('re-reads the policy file on every call', async () => {
        const approval = makeApproval({});
        assert.equal((await approval.check(PLUGIN_SEARCH, {})).allowed, false);
        fs.writeFileSync(policyPath, JSON.stringify({ auto_approve: ['web_search'] }));
        assert.equal((await approval.check(PLUGIN_SEARCH, {})).allowed, true);
    });

    it('truncates long arguments in the dialog text', async () => {
        const approval = makeApproval({});
        await approval.check(MCP_SHELL, { command: 'x'.repeat(5000) });
        assert.ok(asked[0].argsText.length < 1700);
        assert.match(asked[0].argsText, /more characters\)$/);
    });

    it('denialFor explains why a tool did not run', async () => {
        const approval = makeApproval({ blocked: ['web_search'] });
        assert.match(await approval.denialFor(PLUGIN_SEARCH, {}), /blocked in tool_safety\.json/);
        assert.match(await approval.denialFor(MCP_CLICK, {}), /did not allow the tool "Click"/);
        answer = 'once';
        assert.equal(await approval.denialFor(MCP_CLICK, {}), null);
    });
});

describe('shipped tool_safety.json', () => {
    it('is valid and keeps risky Windows-MCP tools out of auto_approve', () => {
        const file = path.join(__dirname, '..', '..', 'tool_safety.json');
        const policy = normalizePolicy(JSON.parse(fs.readFileSync(file, 'utf8')));
        assert.equal(policy.enabled, true);
        for (const risky of ['Click', 'Type', 'App', 'PowerShell', 'FileSystem', 'Process', 'Clipboard', 'Registry', 'Scrape']) {
            assert.equal(matchesRule(`mcp:windows-mcp/${risky}`, policy.auto_approve), false, risky);
        }
        for (const risky of ['execute_code', 'install_packages', 'pc_screen_click', 'click_mouse', 'type_text', 'press_arrow', 'open_webpage']) {
            assert.equal(matchesRule(risky, policy.auto_approve), false, risky);
        }
        assert.equal(matchesRule('mcp:windows-mcp/PowerShell', policy.always_ask), true);
        assert.equal(matchesRule('execute_code', policy.always_ask), true);
    });
});
