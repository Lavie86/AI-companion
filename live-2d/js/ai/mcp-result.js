// mcp-result.js - turns an MCP tools/call result into what ToolExecutor expects.
//
// Text parts are joined. An image part (for example the Windows-MCP Screenshot tool)
// becomes a screenshot result, so llm-handler.js sends the image to the vision model
// instead of dropping it or pasting base64 into the chat as text.

function formatMcpToolResult(result) {
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content
        .filter(part => part && part.type === 'text' && typeof part.text === 'string')
        .map(part => part.text)
        .join('\n');
    const image = content.find(part => part && part.type === 'image' && typeof part.data === 'string' && part.data);

    if (image) {
        return {
            _isScreenshot: true,
            base64: image.data,
            mimeType: typeof image.mimeType === 'string' && image.mimeType ? image.mimeType : 'image/png',
            message: text || 'Screenshot captured.'
        };
    }
    if (text) return text;

    // No text or image: keep the upstream behavior, but never paste large binary data.
    const copy = { ...(result || {}) };
    if (Array.isArray(copy.content)) {
        copy.content = copy.content.map(part => (part && typeof part.data === 'string' && part.data.length > 200)
            ? { ...part, data: `(${part.data.length} characters of ${part.mimeType || 'binary'} data omitted)` }
            : part);
    }
    return JSON.stringify(copy);
}

module.exports = { formatMcpToolResult };
