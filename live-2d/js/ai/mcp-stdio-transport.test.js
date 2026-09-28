'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { MCPStdioTransport } = require('./mcp-stdio-transport.js');
const { MCPToolRegistry } = require('./mcp-tool-registry.js');
const { MCPManager } = require('./mcp-manager.js');

// A strict MCP server: like servers built on strict SDKs, it ignores requests
// that arrive before the client sends notifications/initialized.
const STRICT_SERVER = `
const readline = require('readline');
let initialized = false;
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
        send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'strict', version: '1' } } });
    } else if (msg.method === 'notifications/initialized') {
        initialized = true;
    } else if (!initialized) {
        return;
    } else if (msg.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
            { name: 'Click', description: 'click', inputSchema: { type: 'object' } },
            { name: 'Screenshot', description: 'screen', inputSchema: { type: 'object' } }
        ] } });
    } else if (msg.method === 'tools/call') {
        const content = msg.params.name === 'Screenshot'
            ? [{ type: 'text', text: 'Active window: Notepad' }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }]
            : [{ type: 'text', text: 'clicked' }];
        send({ jsonrpc: '2.0', id: msg.id, result: { content } });
    }
});
`;

function quiet(fn) {
    const log = console.log;
    console.log = () => {};
    return Promise.resolve().then(fn).finally(() => { console.log = log; });
}

describe('MCPStdioTransport', () => {
    const transports = [];

    afterEach(() => {
        while (transports.length) transports.pop().stop();
    });

    it('sends notifications/initialized, so strict servers answer tools/list', async () => {
        const registry = new MCPToolRegistry();
        const transport = new MCPStdioTransport({ command: process.execPath, args: ['-e', STRICT_SERVER] }, registry, 5000);
        transports.push(transport);
        await quiet(() => transport.start('windows-mcp'));
        assert.deepEqual(registry.getToolsByServer('windows-mcp').map(t => t.name), ['Click', 'Screenshot']);
        assert.equal(await transport.callTool('Click', {}), 'clicked');
    });

    it('returns image results as screenshots instead of dropping them', async () => {
        const registry = new MCPToolRegistry();
        const transport = new MCPStdioTransport({ command: process.execPath, args: ['-e', STRICT_SERVER] }, registry, 5000);
        transports.push(transport);
        await quiet(() => transport.start('windows-mcp'));
        assert.deepEqual(await transport.callTool('Screenshot', {}), {
            _isScreenshot: true, base64: 'iVBORw0KGgo=', mimeType: 'image/png', message: 'Active window: Notepad'
        });
    });
});

describe('MCPManager', () => {
    it('uses a per-server startup_timeout', async () => {
        const manager = new MCPManager({ mcp: { enabled: true, startup_timeout: 60000 } });
        const started = Date.now();
        await assert.rejects(
            quiet(() => manager.startServer('slow', {
                command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], startup_timeout: 300
            })),
            /启动失败/
        );
        assert.ok(Date.now() - started < 5000);
        manager.stop();
    });

    it('starts uv/uvx servers in the background like Python servers', async () => {
        const manager = new MCPManager({ mcp: { enabled: true } });
        manager.mcpServers = {
            'windows-mcp': { command: 'uvx', args: ['windows-mcp@0.8.6', 'serve'] },
            'full-path': { command: 'C:\\Users\\me\\.local\\bin\\uvx.exe', args: [] },
            'node-tool': { command: 'node', args: ['./mcp/tools/x.js'] }
        };
        const started = [];
        manager.startServer = (name) => {
            started.push(name);
            // uv servers never finish starting here; startAllServers must not wait for them
            return name === 'node-tool' ? Promise.resolve() : new Promise(() => {});
        };
        await quiet(() => manager.startAllServers());
        assert.deepEqual(started.sort(), ['full-path', 'node-tool', 'windows-mcp']);
    });
});
