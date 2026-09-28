'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatMcpToolResult } = require('./mcp-result.js');

describe('formatMcpToolResult', () => {
    it('joins all text parts', () => {
        const result = { content: [{ type: 'text', text: 'line 1' }, { type: 'text', text: 'line 2' }] };
        assert.equal(formatMcpToolResult(result), 'line 1\nline 2');
    });

    it('turns an image part into a screenshot result for the vision model', () => {
        const result = { content: [{ type: 'text', text: 'Active window: Notepad' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] };
        assert.deepEqual(formatMcpToolResult(result), {
            _isScreenshot: true, base64: 'AAAA', mimeType: 'image/png', message: 'Active window: Notepad'
        });
    });

    it('gives an image without text a default message and type', () => {
        const shot = formatMcpToolResult({ content: [{ type: 'image', data: 'AAAA' }] });
        assert.equal(shot.message, 'Screenshot captured.');
        assert.equal(shot.mimeType, 'image/png');
    });

    it('never pastes large binary data into the chat as text', () => {
        const big = 'x'.repeat(10000);
        const text = formatMcpToolResult({ content: [{ type: 'audio', data: big, mimeType: 'audio/wav' }] });
        assert.ok(text.length < 500);
        assert.match(text, /10000 characters of audio\/wav data omitted/);
    });

    it('falls back to JSON for results without content', () => {
        assert.equal(formatMcpToolResult({ structuredContent: { ok: true } }), '{"structuredContent":{"ok":true}}');
        assert.equal(formatMcpToolResult(undefined), '{}');
    });
});
