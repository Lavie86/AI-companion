'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildDialogOptions, askUser } = require('./tool-approval-dialog.js');

function fakeDialog(respond) {
    const calls = [];
    return {
        calls,
        showMessageBox: async (...args) => {
            const options = args.length === 2 ? args[1] : args[0];
            calls.push({ hasParent: args.length === 2, options });
            return respond(options);
        }
    };
}

describe('buildDialogOptions', () => {
    it('defaults to Deny and offers session approval only when allowed', () => {
        const { options, timeoutSeconds } = buildDialogOptions({
            toolName: 'Click', source: 'MCP server "windows-mcp"', argsText: '{"loc":[1,2]}', canRemember: true, timeoutSeconds: 60
        });
        assert.equal(options.defaultId, 0);
        assert.equal(options.cancelId, 0);
        assert.equal(options.buttons[0], 'Deny');
        assert.deepEqual(options.buttons, ['Deny', 'Allow once', 'Allow for this session']);
        assert.match(options.message, /"Click" \(MCP server "windows-mcp"\)/);
        assert.match(options.detail, /\{"loc":\[1,2\]\}/);
        assert.match(options.detail, /60 seconds counts as Deny/);
        assert.equal(timeoutSeconds, 60);

        const strict = buildDialogOptions({ toolName: 'PowerShell', canRemember: false });
        assert.deepEqual(strict.options.buttons, ['Deny', 'Allow once']);
        assert.equal(strict.timeoutSeconds, 0);
    });
});

describe('askUser', () => {
    it('maps buttons to decisions', async () => {
        for (const [response, expected] of [[0, 'deny'], [1, 'once'], [2, 'session'], [7, 'deny']]) {
            const dialog = fakeDialog(() => ({ response }));
            assert.equal(await askUser(null, { toolName: 'Click' }, dialog), expected);
        }
    });

    it('uses the parent window when there is one', async () => {
        const dialog = fakeDialog(() => ({ response: 1 }));
        await askUser({ id: 'pet-window' }, { toolName: 'Click' }, dialog);
        assert.equal(dialog.calls[0].hasParent, true);
    });

    it('never returns "session" for always_ask tools', async () => {
        const dialog = fakeDialog(() => ({ response: 2 }));
        assert.equal(await askUser(null, { toolName: 'PowerShell', canRemember: false }, dialog), 'once');
    });

    it('denies when nobody answers before the timeout', async () => {
        const dialog = fakeDialog((options) => new Promise((resolve) => {
            options.signal.addEventListener('abort', () => resolve({ response: options.cancelId }));
        }));
        const started = Date.now();
        assert.equal(await askUser(null, { toolName: 'Click', timeoutSeconds: 0.05 }, dialog), 'deny');
        assert.ok(Date.now() - started < 2000);
    });

    it('denies when the dialog throws', async () => {
        const dialog = fakeDialog(() => { throw new Error('boom'); });
        const originalError = console.error;
        console.error = () => {};
        try {
            assert.equal(await askUser(null, { toolName: 'Click' }, dialog), 'deny');
        } finally {
            console.error = originalError;
        }
    });
});
