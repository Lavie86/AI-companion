'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const childProcess = require('child_process');

// Record commands instead of running them. The plugin reads exec when it loads.
const calls = [];
childProcess.exec = (command, options, callback) => {
    const scriptPath = (command.match(/python "([^"]+)"/) || [])[1];
    calls.push({ command, env: options.env, script: fs.readFileSync(scriptPath, 'utf8') });
    callback(null, JSON.stringify({ result: 'clicked' }), '');
};
const PcControlPlugin = require('../index.js');

describe('pc-control plugin', () => {
    it('passes the description and API key through the environment, not the script', async () => {
        const plugin = new PcControlPlugin({}, {
            getPluginFileConfig: () => ({ api_key: { value: 'sk-secret-key' }, api_url: { value: 'https://vision.example/v1' }, model: { value: 'vl-model' } })
        });
        await plugin.onInit();

        // Before the fix, this text became Python code inside an f-string and ran.
        const description = "OK button {open(chr(80)+chr(87),chr(119)).write(chr(120))} ' \" \n import os";
        assert.equal(await plugin.executeTool('pc_screen_click', { element_description: description }), 'clicked');

        const [{ script, env }] = calls;
        assert.ok(!script.includes('sk-secret-key'));
        assert.ok(!script.includes('OK button'));
        assert.ok(!script.includes('${'));
        assert.equal(env.MYNEURO_PC_TARGET, description);
        assert.equal(env.MYNEURO_PC_API_KEY, 'sk-secret-key');
        assert.equal(env.MYNEURO_PC_API_URL, 'https://vision.example/v1');
        assert.equal(env.MYNEURO_PC_MODEL, 'vl-model');
        assert.match(script, /target = os\.environ\.get\('MYNEURO_PC_TARGET', ''\)/);
    });
});
