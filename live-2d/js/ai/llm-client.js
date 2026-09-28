// llm-client.js - 统一的LLM API客户端
const { logToTerminal, handleAPIError } = require('../api-utils.js');
const { sanitizeToolMessageSequence } = require('./tool-message-utils.js');
const { applyReasoningToRequestBody } = require('./reasoning-request.js');

/**
 * 统一的LLM客户端
 * 封装所有LLM API调用逻辑,消除重复代码
 */
class LLMClient {
    /**
     * 支持两种入参：
     *   1. new LLMClient(config)                     - 旧方式，读取 config.llm
     *   2. LLMClient.fromProviderConfig(resolved, r) - 新方式，传入 provider 解析结果（平铺对象）
     */
    constructor(config) {
        // 兼容：完整 config（取 config.llm）或已解析的 provider 平铺对象（直接取字段）
        const llmConfig = (config && config.llm) ? config.llm : (config || {});
        this.apiKey = llmConfig.api_key;
        this.apiUrl = llmConfig.api_url;
        this.model = llmConfig.model;
        this.providerId = llmConfig.id || llmConfig.provider_id || '';
        this.temperature = llmConfig.temperature || 1.0;
        this.temperatureEnabled = llmConfig.temperature_enabled ?? false;
        // 思考模式默认关闭：只有显式 reasoning_enabled === true 才开启
        this.reasoningEnabled = llmConfig.reasoning_enabled === true;
        this.reasoningEffort = llmConfig.reasoning_effort || null;
    }

    /**
     * 从 provider 解析结果创建客户端。
     * @param {object} resolved - llmProviderManager.resolveProvider 系列方法的返回值
     * @param {object} [retryConfig] - 全局重试配置（config.llm.retry）
     * @returns {LLMClient}
     */
    static fromProviderConfig(resolved, retryConfig) {
        return new LLMClient({ ...resolved, retry: retryConfig || resolved.retry || {} });
    }

    /**
     * 发送聊天完成请求
     * @param {Array} messages - 消息数组
     * @param {Array} tools - 可选的工具列表
     * @param {boolean} stream - 是否使用流式响应
     * @param {Function} onChunk - 流式响应时的回调函数，接收每个文本块
     * @returns {Promise<Object>} API响应的消息对象
     */
    async chatCompletion(messages, tools = null, stream = false, onChunk = null) {
        // 🔥 清理消息格式,确保API兼容性
        const cleanedMessages = this._cleanMessagesForAPI(messages);

        const requestBody = {
            model: this.model,
            messages: cleanedMessages,
            stream: stream
        };
        if (this.temperatureEnabled) {
            requestBody.temperature = this.temperature;
        }

        applyReasoningToRequestBody(requestBody, this);

        // 添加工具列表(如果提供)
        if (tools && tools.length > 0) {
            requestBody.tools = tools;
        } else {
            // tools 为 null（视觉模型调用）或空数组（强制获取最终回复、未配置任何工具）
            // 都是预期行为，仅记录 info 便于排查，不输出警告
            logToTerminal('info', `No tool list sent with this call (tools=${tools ? '[]' : 'null'})`);
        }


        // 🔥 调试：在发送前验证JSON格式
        try {
            const testJson = JSON.stringify(requestBody);
            JSON.parse(testJson); // 验证可以正确解析

            // 打印请求统计信息
            const stats = {
                messagesCount: requestBody.messages.length,
                toolsCount: requestBody.tools?.length || 0,
                requestSize: testJson.length,
                temperature: requestBody.temperature  // 🔥 添加temperature到统计信息
            };
//            logToTerminal('info', `📤 API请求统计: ${JSON.stringify(stats)}`);
//            logToTerminal('info', `🌡️ Temperature参数: ${requestBody.temperature}`);  // 🔥 明确打印temperature

            // 如果请求过大,警告
            if (stats.requestSize > 50000) {
//                logToTerminal('warn', `⚠️ 请求体过大 (${Math.round(stats.requestSize/1024)}KB)，可能导致API错误`);
            }
        } catch (jsonError) {
            logToTerminal('error', `❌ Invalid JSON in the request body: ${jsonError.message}`);
            console.error('请求体内容:', requestBody);
            throw new Error(`Invalid request format: ${jsonError.message}`);
        }

        try {
            const response = await fetch(`${this.apiUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                await handleAPIError(response);
            }

            // 🔥 流式响应处理
            if (stream && onChunk) {
                return await this._handleStreamResponse(response, onChunk);
            }

            // 非流式响应处理
            const responseData = await response.json();

            // 验证响应格式
            this._validateResponse(responseData);

            logToTerminal('info', `AI is replying`);

            const message = responseData.choices[0].message;

            // 🔥 处理 Qwen3 等模型的 reasoning_content 字段
            // 仅在没有 tool_calls 时才用 reasoning_content 替代空 content（Qwen3 推理模式）
            // 有 tool_calls 时 reasoning_content 是思考过程，不应作为回复内容（Gemini 等）
            if ((!message.content || message.content.trim() === '') && message.reasoning_content && !message.tool_calls) {
                message.content = message.reasoning_content;
            }

            // 🔥 过滤思考内容（Gemini / DeepSeek 等模型可能在 content 中混入思考）
            if (message.content) {
                message.content = this._filterThinkingContent(message.content);
            }

            // 🔥 解析 Qwen 模型的文本格式工具调用（Hermes/XML style）
            // Qwen 模型返回的是文本格式的 <tool_call>，而不是标准的 tool_calls 对象
            if (message.content && !message.tool_calls) {
                const parsedToolCalls = this._parseQwenToolCalls(message.content);
                if (parsedToolCalls && parsedToolCalls.length > 0) {
                    logToTerminal('info', `🔧 AI called ${parsedToolCalls.length} tools`);
                    message.tool_calls = parsedToolCalls;
                    // 从 content 中移除工具调用部分，只保留文本回复
                    message.content = this._removeToolCallsFromContent(message.content);
                }
            }

            return message;

        } catch (error) {
            // 多模态不支持错误由上层 llm-handler 统一处理和记录，这里不重复打 ERROR
            const isMultimodalError = error.message.toLowerCase().includes('multimodal') ||
                error.message.toLowerCase().includes('does not support image') ||
                error.message.toLowerCase().includes('不支持图片') ||
                error.message.toLowerCase().includes('模型不支持图片');
            if (!isMultimodalError) {
                logToTerminal('error', `LLM API call failed: ${error.message}`);
            }
            throw error;
        }
    }

    /**
     * 清理消息格式,确保API兼容性
     * @private
     * @param {Array} messages - 原始消息数组
     * @returns {Array} 清理后的消息数组
     */
    _cleanMessagesForAPI(messages) {
        const normalizedMessages = messages.map(msg => {
            // 🔥 处理 assistant 消息的 content 为 null 的情况
            if (msg.role === 'assistant') {
                // 如果有 tool_calls 但 content 为 null,设为空字符串
                if (msg.content === null && msg.tool_calls) {
                    return {
                        ...msg,
                        content: '' // 某些API要求content不能为null
                    };
                }
            }

            // 🔥 处理 tool 消息,确保格式正确
            if (msg.role === 'tool') {
                let content = msg.content;

                // 如果content是对象或数组,转为JSON字符串
                if (typeof content === 'object' && content !== null) {
                    try {
                        content = JSON.stringify(content);
                    } catch (e) {
                        content = String(content);
                    }
                }

                // 确保content是字符串
                if (typeof content !== 'string') {
                    content = String(content || '');
                }

                // 🔥 确保字符串不包含控制字符(可能导致JSON解析失败)
                // 移除所有不可见的控制字符,但保留换行符(\n)和制表符(\t)
                content = content.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

                // 🔥 确保字符串长度不超过限制(避免超大响应)
                const MAX_CONTENT_LENGTH = 8000;
                if (content.length > MAX_CONTENT_LENGTH) {
                    content = content.substring(0, MAX_CONTENT_LENGTH) + '...(cut off, too long)';
                }

                // 返回清理后的tool消息
                return {
                    role: 'tool',
                    name: msg.name || 'unknown_tool',
                    content: content,
                    tool_call_id: msg.tool_call_id
                };
            }

            // 其他消息保持原样
            return msg;
        });

        // 🔥 发送前的最后一道防线：清理 assistant.tool_calls 与 tool 响应不配对的序列。
        // 无论坏数据来自旧版本保存的对话历史、裁剪还是工具执行中断，
        // 都保证发给 API 的序列合法，避免 "tool_calls must be followed by tool messages" 400 错误
        return sanitizeToolMessageSequence(normalizedMessages);
    }

    /**
     * 验证API响应格式
     * @private
     */
    _validateResponse(responseData) {
        // 检查API错误响应
        if (responseData.error) {
            const errorMsg = responseData.error.message || responseData.error || 'Unknown API error';
            logToTerminal('error', `LLM API error: ${errorMsg}`);
            // 🔥 将完整的错误信息传递出去，方便重试机制识别
            throw new Error(`API error: ${errorMsg}`);
        }

        // 检查响应格式,适应不同的API响应结构
        let choices;
        if (responseData.choices) {
            choices = responseData.choices;
        } else if (responseData.data && responseData.data.choices) {
            choices = responseData.data.choices;
        } else {
            // 🔥 详细打印响应数据以便调试
            const debugInfo = JSON.stringify(responseData).substring(0, 500);
            logToTerminal('error', `LLM response has an unexpected format: the choices field is missing. Response data: ${debugInfo}`);
            console.error('完整响应数据:', responseData);
            throw new Error('LLM response has an unexpected format: the choices field is missing or empty');
        }

        if (!choices || choices.length === 0) {
            // 🔥 打印完整响应数据
            const debugInfo = JSON.stringify(responseData).substring(0, 500);
            logToTerminal('error', `LLM response choices are empty. Response data: ${debugInfo}`);
            console.error('完整响应数据:', responseData);

            // 🔥 检查响应数据中是否包含"不支持图片"相关的错误信息
            const responseStr = JSON.stringify(responseData).toLowerCase();
            if (responseStr.includes('image') &&
                (responseStr.includes('not support') ||
                 responseStr.includes('不支持') ||
                 responseStr.includes('invalid') ||
                 responseStr.includes('unsupported'))) {
                logToTerminal('error', '⚠️ The model does not seem to support vision');
                throw new Error('The model does not support images: it does not accept the image_url parameter');
            }

            // 🔥 检查是否是内容过滤（多种可能的字段）
            if (responseData.promptFilterResults ||
                responseData.finishReason === 'content_filter' ||
                responseData.finish_reason === 'content_filter') {
                throw new Error('API content filter: the request was blocked by the content filter of the API and may contain sensitive content');
            }

            // 🔥 检查usage，如果有prompt_tokens但completion_tokens为0，很可能是内容过滤
            if (responseData.usage &&
                responseData.usage.prompt_tokens > 0 &&
                responseData.usage.completion_tokens === 0) {
                logToTerminal('warn', '⚠️ API processed the request but refused to generate content. A safety filter may have been triggered');
                throw new Error('API refused to generate content: a safety filter or content policy may have blocked it. Check the recent conversation.');
            }

            throw new Error('LLM response has an unexpected format: choices is empty');
        }

        // 将标准化的choices写回
        responseData.choices = choices;
    }

    /**
     * 解析 Qwen 模型的文本格式工具调用
     * @private
     * @param {string} content - 包含工具调用的文本内容
     * @returns {Array|null} 标准格式的 tool_calls 数组
     */
    _parseQwenToolCalls(content) {
        const toolCalls = [];
        let index = 0;

        // 格式1: <tool_call> ... </tool_call> (JSON 格式)
        const toolCallRegex1 = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
        let match;

        while ((match = toolCallRegex1.exec(content)) !== null) {
            try {
                const toolCallJson = JSON.parse(match[1]);
                toolCalls.push({
                    id: `call_qwen_${Date.now()}_${index}`,
                    type: 'function',
                    function: {
                        name: toolCallJson.name,
                        arguments: JSON.stringify(toolCallJson.arguments || {})
                    }
                });
                index++;
            } catch (error) {
                logToTerminal('warn', `⚠️ Failed to parse a Qwen tool call (format 1): ${error.message}`);
            }
        }

        // 格式2: <function_name attr1="value1" attr2="value2"/> (XML 属性格式)
        // 匹配所有自闭合的 XML 标签，例如: <open_webpage url="..."/>
        const toolCallRegex2 = /<(\w+)\s+([^>]+?)\/>/g;

        while ((match = toolCallRegex2.exec(content)) !== null) {
            const functionName = match[1];
            const attributesStr = match[2];

            // 解析属性
            const attributes = {};
            const attrRegex = /(\w+)="([^"]*)"/g;
            let attrMatch;

            while ((attrMatch = attrRegex.exec(attributesStr)) !== null) {
                attributes[attrMatch[1]] = attrMatch[2];
            }

            // 转换为 OpenAI 标准格式
            toolCalls.push({
                id: `call_qwen_${Date.now()}_${index}`,
                type: 'function',
                function: {
                    name: functionName,
                    arguments: JSON.stringify(attributes)
                }
            });
            index++;
        }

        return toolCalls.length > 0 ? toolCalls : null;
    }

    /**
     * 过滤模型思考/推理内容，防止思考过程被TTS播放或显示为字幕
     * 支持 Gemini、DeepSeek 等模型的多种思考格式
     * @param {string} text - 原始文本
     * @returns {string} 过滤后的文本
     */
    _filterThinkingContent(text) {
        if (!text) return text;

        let filtered = text;

        // 过滤 <think>...</think> 块（DeepSeek、部分 Gemini 格式）
        filtered = filtered.replace(/<think>[\s\S]*?<\/think>/gi, '');

        // 过滤 <thinking>...</thinking> 块
        filtered = filtered.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');

        // 过滤 Gemini 中文思考格式：整段以"思考"开头（独占一行）的内容
        // 仅在整段内容都是思考时才清除（避免误杀正常对话中的"思考"二字）
        if (/^思考\s*\n/.test(filtered)) {
            filtered = '';
        }

        // 过滤 Gemini 英文思考格式：整段以"Thinking"开头（独占一行）
        if (/^Thinking\s*\n/i.test(filtered)) {
            filtered = '';
        }

        return filtered.trim();
    }

    /**
     * 从内容中移除工具调用部分
     * @private
     * @param {string} content - 原始内容
     * @returns {string} 移除工具调用后的内容
     */
    _removeToolCallsFromContent(content) {
        // 移除格式1: <tool_call> ... </tool_call>
        let cleaned = content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');

        // 移除格式2: <function_name attr="value"/>
        cleaned = cleaned.replace(/<\w+\s+[^>]+?\/>/g, '');

        return cleaned.trim();
    }

    /**
     * 处理流式响应
     * @private
     * @param {Response} response - Fetch响应对象
     * @param {Function} onChunk - 接收每个文本块的回调函数
     * @returns {Promise<Object>} 完整的消息对象
     */
    async _handleStreamResponse(response, onChunk) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');

        let buffer = '';
        let fullContent = '';
        let toolCalls = null;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                // 解码数据块
                buffer += decoder.decode(value, { stream: true });

                // 处理SSE格式的数据（data: {...}\n\n）
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // 保留不完整的行

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]') continue;//添加心流API支持

                    if (trimmed.startsWith('data:')) {
                        try {
                            const jsonStr = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5); // 移除 "data: " 前缀，自适应有无空格
                            const chunk = JSON.parse(jsonStr);

                            // 提取内容
                            const delta = chunk.choices?.[0]?.delta;
                            if (!delta) continue;

                            // 处理文本内容
                            if (delta.content) {
                                fullContent += delta.content;
                                onChunk(delta.content); // 🔥 实时回调
                            }

                            // 处理工具调用
                            if (delta.tool_calls) {
                                if (!toolCalls) toolCalls = [];
                                // 累积工具调用信息
                                for (const toolCall of delta.tool_calls) {
                                    const index = toolCall.index || 0;
                                    if (!toolCalls[index]) {
                                        toolCalls[index] = {
                                            id: toolCall.id || '',
                                            type: 'function',
                                            function: { name: '', arguments: '' }
                                        };
                                    }
                                    if (toolCall.id) toolCalls[index].id = toolCall.id;
                                    if (toolCall.function?.name) toolCalls[index].function.name = toolCall.function.name;
                                    if (toolCall.function?.arguments) toolCalls[index].function.arguments += toolCall.function.arguments;
                                }
                            }
                        } catch (parseError) {
                            // 忽略解析错误，继续处理下一行
                            logToTerminal('warn', `⚠️ Failed to parse streamed data: ${parseError.message}`);
                        }
                    }
                }
            }

//            logToTerminal('info', `✅ 流式响应接收完成`);

            // 🔥 过滤思考内容（Gemini 等模型可能在流式 content 中混入思考过程）
            if (fullContent) {
                fullContent = this._filterThinkingContent(fullContent);
            }

            // 构建完整的消息对象
            const message = {
                role: 'assistant',
                content: fullContent || null
            };

            if (toolCalls && toolCalls.length > 0) {
                message.tool_calls = toolCalls;
            }

            // 🔥 解析 Qwen 模型的文本格式工具调用
            if (message.content && !message.tool_calls) {
                const parsedToolCalls = this._parseQwenToolCalls(message.content);
                if (parsedToolCalls && parsedToolCalls.length > 0) {
                    logToTerminal('info', `🔧 AI called ${parsedToolCalls.length} tools`);
                    message.tool_calls = parsedToolCalls;
                    message.content = this._removeToolCallsFromContent(message.content);
                }
            }

            return message;

        } catch (error) {
            logToTerminal('error', `Error while handling the streamed response: ${error.message}`);
            throw error;
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * 更新API配置
     * @param {Object} newConfig - 新的配置对象
     */
    updateConfig(newConfig) {
        if (newConfig.llm) {
            this.apiKey = newConfig.llm.api_key || this.apiKey;
            this.apiUrl = newConfig.llm.api_url || this.apiUrl;
            this.model = newConfig.llm.model || this.model;
            this.temperature = newConfig.llm.temperature !== undefined ? newConfig.llm.temperature : this.temperature;  // 🔥 支持temperature更新
            this.temperatureEnabled = newConfig.llm.temperature_enabled !== undefined ? newConfig.llm.temperature_enabled : this.temperatureEnabled;
            this.reasoningEnabled = newConfig.llm.reasoning_enabled !== undefined
                ? newConfig.llm.reasoning_enabled === true
                : this.reasoningEnabled;
            this.reasoningEffort = newConfig.llm.reasoning_effort !== undefined
                ? newConfig.llm.reasoning_effort
                : this.reasoningEffort;
            logToTerminal('info', 'LLM client config updated');
        }
    }

    /**
     * 获取当前配置
     * @returns {Object}
     */
    getConfig() {
        return {
            apiUrl: this.apiUrl,
            model: this.model
        };
    }
}

module.exports = { LLMClient };
