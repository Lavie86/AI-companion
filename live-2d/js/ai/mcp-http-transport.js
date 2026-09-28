// MCP HTTP 传输层
// 职责：管理 HTTP 连接、MCP SDK 集成、工具调用

const { formatMcpToolResult } = require('./mcp-result.js');

class MCPHttpTransport {
    constructor(serverConfig, toolRegistry, timeout = 30000) {
        this.config = serverConfig;
        this.toolRegistry = toolRegistry;
        this.timeout = timeout;
        this.client = null;
        this.transport = null;
        this.serverName = null;
    }

    // 启动服务器（连接 HTTP 服务器）
    async start(serverName) {
        this.serverName = serverName;

        return new Promise((resolve, reject) => {
            const timeoutHandle = setTimeout(() => {
                reject(new Error(`服务器 ${serverName} 连接超时`));
            }, this.timeout);

            this._connect(serverName, timeoutHandle, resolve, reject);
        });
    }

    // 连接到 HTTP 服务器
    async _connect(serverName, timeoutHandle, resolve, reject) {
        try {
            console.log(`🌐 使用MCP SDK启动HTTP服务器: ${serverName} -> ${this.config.url}`);

            // 导入 MCP SDK
            const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
            const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
            const { ListToolsResultSchema } = require('@modelcontextprotocol/sdk/types.js');

            // 创建 MCP 客户端
            const client = new Client({
                name: "fake-neuro-mcp-client",
                version: "1.0.0"
            }, {
                capabilities: {}
            });

            // 创建 HTTP 传输
            const transport = new StreamableHTTPClientTransport(new URL(this.config.url));

            // 连接到服务器
            await client.connect(transport);
            console.log(`✅ HTTP MCP服务器 ${serverName} 连接成功`);

            this.client = client;
            this.transport = transport;

            // 获取工具列表
            try {
                const toolsResult = await client.request({
                    method: "tools/list",
                    params: {}
                }, ListToolsResultSchema);

                const serverTools = toolsResult.tools || [];
                console.log(`📋 HTTP MCP服务器 ${serverName} 提供 ${serverTools.length} 个工具`);

                this.toolRegistry.registerTools(serverName, serverTools, 'mcp_http');

                clearTimeout(timeoutHandle);
                resolve();

            } catch (toolsError) {
                console.log(`⚠️ HTTP MCP服务器 ${serverName} 获取工具列表失败: ${toolsError.message}`);
                // 即使工具列表获取失败，也标记服务器为可用状态
                clearTimeout(timeoutHandle);
                resolve();
            }

        } catch (error) {
            console.error(`❌ HTTP MCP服务器 ${serverName} SDK连接失败: ${error.message}`);
            clearTimeout(timeoutHandle);
            resolve(); // 不要让单个服务器失败阻塞整体
        }
    }

    // 调用工具
    async callTool(toolName, args) {
        if (!this.client) {
            throw new Error(`HTTP MCP服务器未连接: ${this.serverName}`);
        }

        try {
            console.log(`🔧 调用HTTP MCP工具: ${toolName}，参数:`, args);

            const { CallToolResultSchema } = require('@modelcontextprotocol/sdk/types.js');

            const result = await this.client.request({
                method: "tools/call",
                params: {
                    name: toolName,
                    arguments: args
                }
            }, CallToolResultSchema);

            console.log(`✅ HTTP MCP工具 ${toolName} 调用成功`);

            return formatMcpToolResult(result);

        } catch (error) {
            console.error(`❌ HTTP MCP工具 ${toolName} 调用失败:`, error.message);
            throw new Error(`HTTP MCP工具调用失败: ${error.message}`);
        }
    }

    // 停止服务器（关闭连接）
    stop() {
        if (this.client) {
            try {
                this.client.close?.();
                console.log(`🛑 HTTP MCP服务器 ${this.serverName} 已断开`);
            } catch (error) {
                console.error(`断开HTTP MCP服务器 ${this.serverName} 失败:`, error.message);
            }
            this.client = null;
            this.transport = null;
        }
    }

    // 获取传输类型
    getType() {
        return 'http';
    }
}

module.exports = { MCPHttpTransport };
