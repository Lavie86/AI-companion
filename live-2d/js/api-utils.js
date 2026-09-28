// api-utils.js - API相关工具函数模块
const fs = require('fs');
const path = require('path');

// 终端日志记录函数 - 普通日志
function logToTerminal(level, message) {
    const formattedMsg = `[${level.toUpperCase()}] ${message}`;

    // 输出到Electron DevTools控制台（调试用）
    if (level === 'error') {
        console.error(message);
    } else if (level === 'warn') {
        console.warn(message);
    } else {
        console.log(message);
    }

    // 写入文件供UI读取（Electron应用的日志无法通过stdout传递给父进程）
    try {
        fs.appendFileSync(path.join(__dirname, '..', 'runtime.log'), formattedMsg + '\n', 'utf8');
    } catch (e) {
        // 忽略文件写入错误
    }
}

// 工具日志记录函数 - 专用于工具调用相关日志
function logToolAction(level, message) {
    // 添加 [TOOL] 标记，方便UI区分
    const formattedMsg = `[${level.toUpperCase()}][TOOL] ${message}`;

    // 输出到Electron DevTools控制台（调试用）
    if (level === 'error') {
        console.error(`[TOOL] ${message}`);
    } else if (level === 'warn') {
        console.warn(`[TOOL] ${message}`);
    } else {
        console.log(`[TOOL] ${message}`);
    }

    // 写入到 runtime.log（和普通日志一起，通过[TOOL]标记区分）
    try {
        fs.appendFileSync(path.join(__dirname, '..', 'runtime.log'), formattedMsg + '\n', 'utf8');
    } catch (e) {
        // 忽略文件写入错误
    }
}

// 统一的API错误处理工具函数
async function handleAPIError(response) {
    let errorDetail = "";
    try {
        const errorBody = await response.text();
        try {
            const errorJson = JSON.parse(errorBody);
            errorDetail = JSON.stringify(errorJson, null, 2);
        } catch (e) {
            errorDetail = errorBody;
        }
    } catch (e) {
        errorDetail = "Could not read the error details";
    }

    // 多模态不支持是预期的可恢复错误，降级为 warn 避免误导用户
    const isMultimodalUnsupported = errorDetail.toLowerCase().includes('multimodal') ||
        (response.status === 400 && errorDetail.toLowerCase().includes('image') && errorDetail.toLowerCase().includes('support'));
    if (isMultimodalUnsupported) {
        logToTerminal('warn', `📷 The current model does not support images/multimodal input. Removing the images and retrying`);
    } else {
        logToTerminal('error', `API error (${response.status} ${response.statusText}):\n${errorDetail}`);
    }

    let errorMessage = "";
    switch (response.status) {
        case 401:
            errorMessage = "API key rejected. Check your API key";
            break;
        case 403:
            errorMessage = "API access denied. Your account may be restricted";
            break;
        case 404:
            errorMessage = "API endpoint not found. Check the API URL";
            break;
        case 429:
            errorMessage = "Too many requests. You hit the API rate limit";
            break;
        case 500:
        case 502:
        case 503:
        case 504:
            errorMessage = "Server error. The AI service is unavailable right now";
            break;
        default:
            errorMessage = `API error: ${response.status} ${response.statusText}`;
    }

    throw new Error(`${errorMessage}\nDetails: ${errorDetail}`);
}

// 统一的工具列表合并函数
function getMergedToolsList() {
    let allTools = [];

    // 添加MCP工具
    if (global.mcpManager && global.mcpManager.isEnabled) {
        const mcpTools = global.mcpManager.getToolsForLLM();
        if (mcpTools && mcpTools.length > 0) {
            allTools.push(...mcpTools);
        }
    }

    // 添加插件工具
    if (global.pluginManager) {
        const pluginTools = global.pluginManager.getAllTools();
        if (pluginTools && pluginTools.length > 0) {
            allTools.push(...pluginTools);
        }
    }

    return allTools;
}

module.exports = {
    logToTerminal,
    logToolAction,
    handleAPIError,
    getMergedToolsList
};
