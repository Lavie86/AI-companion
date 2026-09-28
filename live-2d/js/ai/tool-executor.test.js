'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { toolExecutor } = require('./tool-executor.js');
const { toolApproval } = require('./tool-approval.js');

function call(id, name, args = {}) {
    return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

describe('ToolExecutor with the approval gate', () => {
    let dir;
    let asked;
    let answers;
    let ran;
    const saved = {};

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-executor-'));
        const policyPath = path.join(dir, 'tool_safety.json');
        fs.writeFileSync(policyPath, JSON.stringify({
            auto_approve: ['web_search', 'mcp:windows-mcp/Screenshot'],
            always_ask: ['mcp:windows-mcp/PowerShell']
        }));
        asked = [];
        answers = [];
        ran = [];

        saved.policyPath = toolApproval.policyPath;
        saved.ask = toolApproval.ask;
        saved.mcpManager = global.mcpManager;
        saved.pluginManager = global.pluginManager;
        toolApproval.policyPath = policyPath;
        toolApproval.sessionAllowed.clear();
        toolApproval.ask = async (request) => {
            asked.push(request.toolId);
            return answers.shift() || 'deny';
        };

        const mcpTools = new Map([['Screenshot', 'windows-mcp'], ['Click', 'windows-mcp'], ['PowerShell', 'windows-mcp']]);
        global.mcpManager = {
            isEnabled: true,
            toolRegistry: {
                findTool: (name) => (mcpTools.has(name) ? { name, server: mcpTools.get(name), type: 'mcp' } : undefined)
            },
            handleToolCalls: async ([toolCall]) => {
                if (!mcpTools.has(toolCall.function.name)) return null;
                ran.push(`mcp:${toolCall.function.name}`);
                return `mcp ${toolCall.function.name} done`;
            }
        };
        const pluginTools = [
            { type: 'function', function: { name: 'web_search' } },
            { type: 'function', function: { name: 'click_mouse' } }
        ];
        global.pluginManager = {
            getAllTools: () => pluginTools,
            executeTool: async (name) => {
                if (!pluginTools.some(t => t.function.name === name)) throw new Error('not found');
                ran.push(`plugin:${name}`);
                return `plugin ${name} done`;
            }
        };
    });

    afterEach(() => {
        toolApproval.policyPath = saved.policyPath;
        toolApproval.ask = saved.ask;
        toolApproval.sessionAllowed.clear();
        global.mcpManager = saved.mcpManager;
        global.pluginManager = saved.pluginManager;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('runs auto-approved MCP and plugin tools without asking', async () => {
        assert.equal(await toolExecutor.executeToolCalls([call('1', 'Screenshot')]), 'mcp Screenshot done');
        assert.equal(await toolExecutor.executeToolCalls([call('2', 'web_search', { q: 'x' })]), 'plugin web_search done');
        assert.deepEqual(asked, []);
        assert.deepEqual(ran, ['mcp:Screenshot', 'plugin:web_search']);
    });

    it('does not run a denied MCP tool and tells the LLM why', async () => {
        const result = await toolExecutor.executeToolCalls([call('1', 'Click', { loc: [1, 2] })]);
        assert.deepEqual(asked, ['mcp:windows-mcp/Click']);
        assert.deepEqual(ran, []);
        assert.match(result, /did not allow the tool "Click"/);
    });

    it('does not run a denied plugin tool', async () => {
        const result = await toolExecutor.executeToolCalls([call('1', 'click_mouse')]);
        assert.deepEqual(asked, ['click_mouse']);
        assert.deepEqual(ran, []);
        assert.match(result, /did not allow/);
    });

    it('runs a tool the user allows', async () => {
        answers = ['once'];
        assert.equal(await toolExecutor.executeToolCalls([call('1', 'click_mouse')]), 'plugin click_mouse done');
        assert.deepEqual(ran, ['plugin:click_mouse']);
    });

    it('does not ask about tools that nobody provides', async () => {
        const result = await toolExecutor.executeToolCalls([call('1', 'made_up_tool')]);
        assert.deepEqual(asked, []);
        assert.equal(result, null);
    });

    it('answers every tool call id when some calls are denied', async () => {
        answers = ['deny', 'once'];
        const result = await toolExecutor.executeToolCalls([
            call('a', 'PowerShell', { command: 'Remove-Item x' }),
            call('b', 'Click'),
            call('c', 'Screenshot')
        ]);
        assert.deepEqual(asked, ['mcp:windows-mcp/PowerShell', 'mcp:windows-mcp/Click']);
        assert.deepEqual(ran, ['mcp:Click', 'mcp:Screenshot']);
        assert.deepEqual(result.map(r => r.tool_call_id), ['a', 'b', 'c']);
        assert.match(result[0].content, /did not allow the tool "PowerShell"/);
        assert.equal(result[1].content, 'mcp Click done');
    });

    it('approves an MCP tool and its plugin fallback separately', async () => {
        global.mcpManager.toolRegistry.findTool = (name) => (name === 'click_mouse' ? { name, server: 'other', type: 'mcp' } : undefined);
        global.mcpManager.handleToolCalls = async () => { throw new Error('server crashed'); };
        answers = ['once', 'deny'];
        const result = await toolExecutor.executeToolCalls([call('1', 'click_mouse')]);
        assert.deepEqual(asked, ['mcp:other/click_mouse', 'click_mouse']);
        assert.deepEqual(ran, []);
        assert.match(result, /did not allow/);
    });
});
