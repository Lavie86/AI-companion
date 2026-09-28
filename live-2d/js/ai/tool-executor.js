// tool-executor.js - 统一的工具调用执行器
const { logToTerminal, logToolAction } = require('../api-utils.js');
const { toolApproval } = require('./tool-approval.js');

// The MCP tool that handles this name, if MCP is on (same lookup as mcpManager.handleToolCalls).
function findMcpTool(functionName) {
    const manager = global.mcpManager;
    if (!manager || !manager.isEnabled || !manager.toolRegistry) return null;
    return manager.toolRegistry.findTool(functionName) || null;
}

// True when a loaded plugin offers this tool (pluginManager.executeTool would find it).
function pluginProvidesTool(functionName) {
    try {
        return global.pluginManager.getAllTools()
            .some(tool => tool && (tool.name === functionName || tool.function?.name === functionName));
    } catch (error) {
        return false;
    }
}

// 遥测：可选依赖，加载/写盘失败必须吞掉，不能影响工具执行
let _emitTelemetry = null;
try { _emitTelemetry = require('../core/telemetry.js').emitTelemetry; } catch (e) { _emitTelemetry = null; }
function safeEmitTelemetry(payload) {
    if (!_emitTelemetry) return;
    try { _emitTelemetry(payload); } catch (e) { /* 静默 */ }
}

/**
 * 统一的工具调用执行器
 * 负责协调MCP工具和本地Function Call工具的调用
 * 消除重复的工具调用逻辑
 */
class ToolExecutor {
    constructor() {
        // 工具管理器将通过全局变量访问
        // 这是合理的,因为它们是单例服务
    }

    /**
     * 执行工具调用
     * @param {Array} toolCalls - LLM返回的工具调用列表
     * @returns {Promise<Array|string|Object|null>} 工具执行结果
     */
    async executeToolCalls(toolCalls) {
        if (!toolCalls || toolCalls.length === 0) {
            return null;
        }

        const results = [];
        let hasToolExecuted = false;
        let screenshotData = null;  // 🔥 用于存储截图数据

        for (const toolCall of toolCalls) {
            const functionName = toolCall.function.name;
            const toolStartTs = Date.now();
            safeEmitTelemetry({
                cat: 'tool',
                type: 'tool.start',
                title: `Calling tool: ${functionName}`,
                source: 'main'
            });
            let toolResult = null;

            // 解析参数
            let parameters;
            try {
                parameters = typeof toolCall.function.arguments === 'string'
                    ? JSON.parse(toolCall.function.arguments)
                    : toolCall.function.arguments;
            } catch (error) {
                console.error('解析工具参数错误:', error);
                parameters = {};
            }

            // 🎈 显示工具调用气泡框（带参数）
            if (typeof global.showToolBubble === 'function') {
                global.showToolBubble(functionName, parameters);
            }

            // Ask the user first when a tool can change the PC (js/ai/tool-approval.js, tool_safety.json).
            // Each source is approved on its own: an MCP tool as "mcp:<server>/<name>", a plugin tool by its name.
            let denial = null;
            const mcpTool = findMcpTool(functionName);

            // 优先尝试MCP工具
            if (mcpTool) {
                denial = await toolApproval.denialFor({
                    toolId: `mcp:${mcpTool.server}/${functionName}`,
                    toolName: functionName,
                    source: `MCP server "${mcpTool.server}"`
                }, parameters);

                if (!denial) {
                    try {
                        const mcpResult = await global.mcpManager.handleToolCalls([toolCall]);
                        if (mcpResult) {
                            toolResult = mcpResult;
                            hasToolExecuted = true;
                        }
                    } catch (error) {
                        logToolAction('warn', `MCP tool ${functionName} failed, trying a local tool: ${error.message}`);
                    }
                }
            }

            // 如果MCP没有处理，尝试插件工具
            if (!toolResult && !denial && global.pluginManager && pluginProvidesTool(functionName)) {
                denial = await toolApproval.denialFor({
                    toolId: functionName,
                    toolName: functionName,
                    source: 'plugin'
                }, parameters);

                if (!denial) {
                    try {
                        const pluginResult = await global.pluginManager.executeTool(functionName, parameters);
                        if (pluginResult !== undefined) {
                            toolResult = pluginResult;
                            hasToolExecuted = true;
                        }
                    } catch (error) {
                        logToolAction('error', `Plugin tool ${functionName} failed: ${error.message}`);
                    }
                }
            }

            // The LLM still gets a tool result for a denied call, so the conversation stays valid.
            if (denial) {
                logToolAction('warn', `Tool ${functionName} did not run: ${denial}`);
                toolResult = denial;
                hasToolExecuted = true;
            }

            // 如果工具执行成功，添加结果
            if (toolResult) {
                // 🔥 特殊处理截图工具的返回值
                if (typeof toolResult === 'object' && toolResult._isScreenshot) {
                    console.log('🎯 检测到截图工具返回，准备特殊处理');
                    screenshotData = {
                        tool_call_id: toolCall.id,
                        base64: toolResult.base64,
                        mimeType: toolResult.mimeType,
                        message: toolResult.message
                    };
                    // 将简单的成功消息添加到结果中
                    results.push({
                        tool_call_id: toolCall.id,
                        content: toolResult.message
                    });
                }
                // 处理不同格式的结果
                else if (Array.isArray(toolResult)) {
                    results.push(...toolResult);
                } else if (typeof toolResult === 'object' && toolResult.content) {
                    results.push(toolResult);
                } else {
                    results.push({
                        tool_call_id: toolCall.id,
                        content: toolResult
                    });
                }
            } else {
                // 工具未找到或执行失败
                results.push({
                    tool_call_id: toolCall.id,
                    content: `Tool ${functionName} failed or was not found`
                });
                logToolAction('error', `Tool ${functionName} was not found or failed`);
            }

            // 工具结束遥测（含耗时与成败）
            const toolDurationMs = Date.now() - toolStartTs;
            const toolSecs = (toolDurationMs / 1000).toFixed(1);
            const toolFailed = !toolResult || Boolean(denial);
            safeEmitTelemetry({
                cat: 'tool',
                type: toolFailed ? 'tool.error' : 'tool.end',
                title: toolFailed ? `Tool ${functionName} failed (${toolSecs}s)` : `Tool ${functionName} done (${toolSecs}s)`,
                level: toolFailed ? 'error' : 'info',
                metrics: { duration_ms: toolDurationMs },
                source: 'main'
            });
        }

        if (!hasToolExecuted) {
            logToolAction('error', 'All tool calls failed');
            return null;
        }

        // 🔥 如果有截图数据，返回特殊格式
        if (screenshotData) {
            return {
                _hasScreenshot: true,
                screenshotData: screenshotData,
                results: results
            };
        }

        // 如果只有一个结果，返回单个字符串(向后兼容)
        if (results.length === 1 && typeof results[0] === 'string') {
            return results[0];
        }

        // 如果只有一个结果对象，返回其content(向后兼容)
        if (results.length === 1 && results[0].content) {
            return results[0].content;
        }

        // 返回完整的结果数组
        return results;
    }

    /**
     * 检查是否有可用的工具管理器
     * @returns {boolean}
     */
    hasToolManagers() {
        const hasMCP = global.mcpManager && global.mcpManager.isEnabled;
        return hasMCP;
    }

    /**
     * 获取工具统计信息
     * @returns {Object}
     */
    getStats() {
        const stats = {
            mcpEnabled: false,
            mcpToolCount: 0,
            totalTools: 0
        };

        if (global.mcpManager && global.mcpManager.isEnabled) {
            stats.mcpEnabled = true;
            const mcpStats = global.mcpManager.getStats();
            stats.mcpToolCount = mcpStats.tools || 0;
        }

        stats.totalTools = stats.mcpToolCount;

        return stats;
    }
}

// 导出单例
const toolExecutor = new ToolExecutor();
module.exports = { toolExecutor, ToolExecutor };
