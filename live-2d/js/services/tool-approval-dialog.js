// tool-approval-dialog.js - main-process side of the tool approval gate (js/ai/tool-approval.js).
// The renderer asks over IPC before it runs a tool. This shows a native dialog and
// answers 'deny', 'once' or 'session'. Closing the dialog, a timeout or any error is 'deny'.

const CHANNEL = 'tool-approval:ask';
const DECISIONS = ['deny', 'once', 'session'];

function buildDialogOptions(request = {}) {
    const toolName = String(request.toolName || 'unknown tool');
    const source = request.source ? ` (${String(request.source)})` : '';
    const canRemember = request.canRemember !== false;
    const timeoutSeconds = Number(request.timeoutSeconds) > 0 ? Number(request.timeoutSeconds) : 0;

    const detailParts = [
        `Arguments:\n${String(request.argsText || '{}')}`,
        'Only allow this if you asked for it. Text on web pages, in games, in chat or on your screen can trick the AI into asking.'
    ];
    if (timeoutSeconds) {
        detailParts.push(`No answer in ${timeoutSeconds} seconds counts as Deny.`);
    }

    const options = {
        type: 'warning',
        title: 'Allow this action?',
        message: `Your companion wants to run "${toolName}"${source}.`,
        detail: detailParts.join('\n\n'),
        buttons: canRemember ? ['Deny', 'Allow once', 'Allow for this session'] : ['Deny', 'Allow once'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
    };
    return { options, timeoutSeconds };
}

async function askUser(parentWindow, request = {}, electronDialog = require('electron').dialog) {
    const { options, timeoutSeconds } = buildDialogOptions(request);
    const controller = timeoutSeconds ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutSeconds * 1000) : null;
    if (controller) options.signal = controller.signal;

    try {
        // A parent window keeps the dialog above the always-on-top pet window.
        const { response } = parentWindow
            ? await electronDialog.showMessageBox(parentWindow, options)
            : await electronDialog.showMessageBox(options);
        const decision = DECISIONS[response] || 'deny';
        return decision === 'session' && request.canRemember === false ? 'once' : decision;
    } catch (error) {
        console.error('Tool approval dialog failed, denying:', error);
        return 'deny';
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function registerToolApprovalDialog() {
    const { ipcMain, BrowserWindow } = require('electron');
    ipcMain.handle(CHANNEL, async (event, request) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        return askUser(win && !win.isDestroyed() ? win : null, request || {});
    });
}

module.exports = { registerToolApprovalDialog, buildDialogOptions, askUser, CHANNEL };
