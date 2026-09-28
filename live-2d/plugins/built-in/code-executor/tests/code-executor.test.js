'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const childProcess = require('child_process');

// Record commands instead of running them. The plugin reads exec when it loads.
const calls = [];
childProcess.exec = (command, options, callback) => {
    const scriptPath = (command.match(/python "([^"]+)"/) || [])[1];
    calls.push({ command, env: options.env, script: scriptPath ? fs.readFileSync(scriptPath, 'utf8') : null });
    callback(null, JSON.stringify({ success: true, stdout: 'ok', stderr: '', description: 'd' }), '');
};
const CodeExecutorPlugin = require('../index.js');

describe('code-executor plugin', () => {
    let plugin;

    beforeEach(() => {
        calls.length = 0;
        plugin = new CodeExecutorPlugin({}, {});
    });

    it('keeps the description out of the generated Python source', async () => {
        const description = 'x", "y": __import__("os").system("calc")} #';
        await plugin.executeTool('execute_code', { code: 'print(1)', description });
        assert.equal(calls.length, 1);
        assert.ok(!calls[0].script.includes(description));
        assert.ok(!calls[0].script.includes('__import__("os").system'));
        assert.equal(calls[0].env.MYNEURO_CODE_DESCRIPTION, description);
        assert.match(calls[0].script, /\n    print\(1\)\n/);
    });

    it('quotes valid pip requirements', async () => {
        await plugin.executeTool('install_packages', { packages: 'requests numpy>=1.26 uvicorn[standard] torch==2.4.0,!=2.4.1' });
        assert.match(calls[0].command, /pip install "requests" "numpy>=1\.26" "uvicorn\[standard\]" "torch==2\.4\.0,!=2\.4\.1"$/);
    });

    it('refuses package lists that contain shell commands', async () => {
        for (const packages of ['requests & del /q x', 'requests;rm -rf ~', 'a|b', '$(id)', '`id`', '"quoted"', 'a%PATH%', 'pkg --index-url http://evil', '../local']) {
            await assert.rejects(plugin.executeTool('install_packages', { packages }), /Invalid package name/, packages);
        }
        assert.equal(calls.length, 0);
    });
});
