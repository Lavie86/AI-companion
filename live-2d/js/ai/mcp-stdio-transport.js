// MCP Stdio 传输层
// 职责：管理子进程、Stdio 通信、工具调用

const { spawn } = require('child_process');
const path = require('path');
const { logToTerminal } = require('../api-utils.js');
const { formatMcpToolResult } = require('./mcp-result.js');

class MCPStdioTransport {
    constructor(serverConfig, toolRegistry, timeout = 30000) {
        this.config = serverConfig;
        this.toolRegistry = toolRegistry;
        this.timeout = timeout;
        this.process = null;
        this.serverName = null;
    }

    // 启动服务器
    async start(serverName) {
        this.serverName = serverName;

        return new Promise((resolve, reject) => {
            const timeoutHandle = setTimeout(() => {
                // Stop the server process too, or every slow start leaves one running
                this.stop();
                reject(new Error(`服务器 ${serverName} 启动超时`));
            }, this.timeout);

            try {
                console.log(`🚀 启动MCP Stdio服务器: ${serverName}`);

                let { command, args = [] } = this.config;

                // 特殊处理：为本地 MCP 服务器设置工作目录
                let cwd = process.cwd();
                if (serverName === 'local' && args.includes('server.js')) {
                    cwd = path.resolve('./mcp');
                }

                // 动态解析 command 路径：如果是相对路径，转换为绝对路径
                if (command.startsWith('./') || command.startsWith('.\\')) {
                    command = path.resolve(cwd, command);
                    console.log(`🔧 转换相对路径为绝对路径: ${command}`);
                }

                // 启动子进程
                const childProcess = spawn(command, args, {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env: {
                        ...process.env,
                        FASTMCP_QUIET: '1',  // 禁用 FastMCP Logo
                        ...(this.config.env || {})
                    },
                    shell: process.platform === 'win32',
                    cwd: cwd
                });

                this.process = childProcess;

                // 错误处理
                childProcess.on('error', (error) => {
                    clearTimeout(timeoutHandle);
                    let errorMsg = `服务器 ${serverName} 启动失败: ${error.message}`;

                    // 如果是找不到命令的错误,提供更友好的提示
                    if (error.code === 'ENOENT') {
                        errorMsg += `\n提示: 找不到命令 '${command}'`;
                        if (command === 'node' || command.includes('node')) {
                            errorMsg += '\n请确保已安装 Node.js 或使用项目内置的 node.exe';
                        } else if (command === 'python') {
                            errorMsg += '\n请确保已安装 Python 并添加到系统环境变量';
                        }
                    }

                    reject(new Error(errorMsg));
                });

                // 监听错误输出
                let stderrOutput = '';
                childProcess.stderr.on('data', (data) => {
                    stderrOutput += data.toString();
                    // 不输出 stderr
                });

                // 监听进程退出
                childProcess.on('exit', (code, signal) => {
                    if (code !== 0) {
                        console.error(`❌ MCP服务器 ${serverName} 异常退出, 代码: ${code}, 信号: ${signal}`);
                        if (stderrOutput) {
                            console.error(`错误输出: ${stderrOutput}`);
                        }
                    }
                });

                // 初始化服务器
                this._initialize(childProcess, serverName, timeoutHandle, resolve, reject);

            } catch (error) {
                clearTimeout(timeoutHandle);
                reject(error);
            }
        });
    }

    // 初始化服务器（发送 initialize 和 tools/list 请求）
    _initialize(childProcess, serverName, timeoutHandle, resolve, reject) {
        // 发送初始化请求
        const initRequest = {
            jsonrpc: "2.0",
            id: `init_${serverName}_${Date.now()}`,
            method: "initialize",
            params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "fake-neuro-mcp-client", version: "1.0.0" }
            }
        };

        childProcess.stdin.write(JSON.stringify(initRequest) + '\n');

        // 处理响应
        let buffer = '';
        let initialized = false;

        const onData = (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.trim()) {
                    try {
                        const response = JSON.parse(line);

                        // 处理初始化响应
                        if (response.id === initRequest.id) {
                            // The MCP spec requires this notification before other requests.
                            // Strict servers ignore tools/list without it.
                            childProcess.stdin.write(JSON.stringify({
                                jsonrpc: "2.0",
                                method: "notifications/initialized"
                            }) + '\n');

                            // 初始化完成，获取工具列表
                            const toolsRequest = {
                                jsonrpc: "2.0",
                                id: `tools_${serverName}_${Date.now()}`,
                                method: "tools/list"
                            };
                            childProcess.stdin.write(JSON.stringify(toolsRequest) + '\n');

                        } else if (response.id && response.id.startsWith(`tools_${serverName}_`) && response.result) {
                            // 获得工具列表
                            const serverTools = response.result.tools || [];
                            this.toolRegistry.registerTools(serverName, serverTools, 'mcp');

                            if (!initialized) {
                                initialized = true;
                                childProcess.stdout.removeListener('data', onData);
                                clearTimeout(timeoutHandle);
                                resolve();
                            }
                        }
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            }
        };

        childProcess.stdout.on('data', onData);
    }

    // 调用工具
    async callTool(toolName, args) {
        if (!this.process) {
            throw new Error(`MCP服务器未启动: ${this.serverName}`);
        }

        const request = {
            jsonrpc: "2.0",
            id: `call_${toolName}_${Date.now()}`,
            method: "tools/call",
            params: {
                name: toolName,
                arguments: args
            }
        };

        this.process.stdin.write(JSON.stringify(request) + '\n');

        return new Promise((resolve, reject) => {
            let buffer = '';
            const timeout = setTimeout(() => {
                reject(new Error(`工具调用超时: ${toolName}`));
            }, 30000);

            const onData = (data) => {
                buffer += data.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.trim()) {
                        try {
                            const response = JSON.parse(line);
                            if (response.id === request.id) {
                                this.process.stdout.removeListener('data', onData);
                                clearTimeout(timeout);

                                if (response.error) {
                                    reject(new Error(response.error.message));
                                } else {
                                    resolve(formatMcpToolResult(response.result));
                                }
                            }
                        } catch (e) {
                            console.error(`解析工具调用响应失败 (${toolName}):`, e.message);
                        }
                    }
                }
            };

            this.process.stdout.on('data', onData);
        });
    }

    // 停止服务器
    stop() {
        if (this.process) {
            try {
                // Closing stdin tells a stdio MCP server to exit.
                try { this.process.stdin.end(); } catch (e) { /* already closed */ }
                // On Windows the server runs under cmd.exe (shell: true), and kill() stops only
                // cmd.exe. taskkill /T also stops uvx and the Python server it started.
                if (process.platform === 'win32' && this.process.pid) {
                    spawn('taskkill', ['/pid', String(this.process.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
                        .on('error', () => {});
                }
                this.process.kill();
                console.log(`🛑 MCP Stdio服务器 ${this.serverName} 已停止`);
            } catch (error) {
                console.error(`停止MCP服务器 ${this.serverName} 失败:`, error.message);
            }
            this.process = null;
        }
    }

    // 获取传输类型
    getType() {
        return 'stdio';
    }
}

module.exports = { MCPStdioTransport };
