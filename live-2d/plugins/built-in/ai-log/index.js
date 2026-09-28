// plugins/built-in/ai-log/index.js
// AI 日志插件 —— 提供每日日志生成、历史查看、月度总结工具

const { Plugin } = require('../../../js/core/plugin-base.js');
const fs = require('fs');
const path = require('path');

class AiLogPlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig();
        this._rootDir = path.join(__dirname, '..', '..', '..');

        this._apiUrl = cfg.api_url || '';
        this._apiKey = cfg.api_key || '';
        this._model = cfg.model || '';
        this._thinkingMode = cfg.thinking_mode || 'enabled';
        this._reasoningEffort = cfg.reasoning_effort || 'max';
        this._diaryFolder = cfg.diary_folder || 'AI记录室/AI日志';
        this._diaryFilenameTemplate = cfg.diary_filename_template || '{date}-AI日志.txt';
        this._monthlyFilenameTemplate = cfg.monthly_filename_template || '{month}-月度总结.txt';
        const resolvePath = (filePath, defaultPath) => {
            const value = (filePath && String(filePath).trim()) || defaultPath;
            return path.isAbsolute(value) ? path.normalize(value) : path.join(this._rootDir, value);
        };

        this._coreMemoryPath = resolvePath(cfg.core_memory_file, 'AI记录室/核心用户记忆.txt');
        this._conversationHistoryPath = resolvePath(cfg.conversation_history_file, 'AI记录室/记忆库.txt');
        this._historyBackupFolder = cfg.history_backup_folder || '';
        this._dailyPrompt = cfg.daily_prompt || '';
        this._monthlyPrompt = cfg.monthly_prompt || '';
        this._triggerAfterHour = cfg.trigger_after_hour ?? 21;
        this._maxRetries = cfg.max_retries ?? 3;
        this._nightHourStart = cfg.night_hour_start ?? 7;
    }

    async onStart() {
        this.context.log('info', `AI journal plugin started | journal folder: ${this._diaryFolder}`);
    }

    // ===== 工具注册 =====

    getTools() {
        return [
            {
                type: 'function',
                function: {
                    name: 'write_ai_diary',
                    description: `Write today's AI journal: sum up today's conversation, save it as an observation report and also add it to core memory. [Strict rule] You may call this only in these two cases: 1) The user clearly and directly asks you to write the AI journal (trigger_reason="user_requested", force=true); 2) In their current message the user clearly says they are going to sleep (they said "good night", "I'm going to bed", "time to sleep" or similar), and the time is between ${this._triggerAfterHour}:00 at night and ${this._nightHourStart}:00 in the early morning (trigger_reason="user_said_goodnight", force=false). [Never] call this tool on your own when the user has not said one of these phrases, not even late at night. Do not guess what the user wants and do not write the journal unprompted.`,
                    parameters: {
                        type: 'object',
                        properties: {
                            force: {
                                type: 'boolean',
                                description: 'Whether to force it (skips the time window check). Pass true when the user explicitly asks for the journal. For a good night trigger, pass false'
                            },
                            trigger_reason: {
                                type: 'string',
                                enum: ['user_requested', 'user_said_goodnight'],
                                description: '[Required] Why you are calling it. user_requested=the user asks for the journal in their current message; user_said_goodnight=the user says good night, going to sleep or similar in their current message. Never make up a reason when neither is true.'
                            }
                        },
                        required: ['trigger_reason']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'read_recent_diary',
                    description: 'Read the AI journal of the last few days to recall what happened recently',
                    parameters: {
                        type: 'object',
                        properties: {
                            days: {
                                type: 'number',
                                description: 'How many days of journal to read. Default: 3'
                            }
                        },
                        required: []
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'write_monthly_summary',
                    description: 'Call this on the 1st of each month to write last month\'s summary. It reads all of last month\'s AI journal entries and writes a monthly observation report from your point of view.',
                    parameters: {
                        type: 'object',
                        properties: {},
                        required: []
                    }
                }
            }
        ];
    }

    async executeTool(name, params) {
        this.context.log('info', `Running tool: ${name}`);

        switch (name) {
            case 'write_ai_diary':
                return await this._writeDiary(params.force || false, params.trigger_reason);
            case 'read_recent_diary':
                return this._readRecentDiary(params.days || 3);
            case 'write_monthly_summary':
                return await this._writeMonthlySummary();
            default:
                throw new Error(`Unsupported tool: ${name}`);
        }
    }

    // ===== 日期工具 =====

    _getProperDate() {
        const now = new Date();
        if (now.getHours() < this._nightHourStart) {
            now.setDate(now.getDate() - 1);
        }
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    _getLastMonth() {
        const now = new Date();
        now.setMonth(now.getMonth() - 1);
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        return `${y}-${m}`;
    }

    _getTimestamp() {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }

    // ===== API 调用 =====

    async _callAPI(systemPrompt, userContent) {
        const mainApiUrl = global.voiceChat?.API_URL || '';
        const apiUrl = this._apiUrl || (mainApiUrl ? `${mainApiUrl.replace(/\/chat\/completions\/?$/, '')}/chat/completions` : '');
        const apiKey = this._apiKey || global.voiceChat?.API_KEY;
        const model = this._model || global.voiceChat?.MODEL;

        if (!apiUrl || !apiKey) {
            throw new Error('API settings are missing. Set them in plugin_config.json or make sure the main LLM is available');
        }

        for (let attempt = 1; attempt <= this._maxRetries; attempt++) {
            try {
                const requestBody = {
                    model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userContent }
                    ],
                    max_tokens: 8000,
                    temperature: 0.7
                };

                const thinkingMode = String(this._thinkingMode || '').toLowerCase();
                if (thinkingMode === 'enabled' || thinkingMode === 'disabled') {
                    requestBody.thinking = { type: thinkingMode };
                }
                if (this._reasoningEffort) {
                    requestBody.reasoning_effort = this._reasoningEffort;
                }

                this.context.log('info', `Calling the API, attempt ${attempt} | model: ${model} | thinking: ${thinkingMode || 'default'} | reasoning_effort: ${this._reasoningEffort || 'default'}`);

                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify(requestBody)
                });

                const data = await response.json();

                if (data.choices?.[0]?.message) {
                    this.context.log('info', 'API call succeeded');
                    return data.choices[0].message.content;
                }
                if (data.error) {
                    throw new Error(`API error: ${data.error.message || JSON.stringify(data.error)}`);
                }
                throw new Error('API response has an unexpected format');
            } catch (error) {
                this.context.log('error', `Attempt ${attempt} failed: ${error.message}`);
                if (attempt === this._maxRetries) throw error;
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    // ===== 文件 IO =====

    _readConversationHistory() {
        if (!fs.existsSync(this._conversationHistoryPath)) return null;
        const content = fs.readFileSync(this._conversationHistoryPath, 'utf-8');
        return content.trim() || null;
    }

    _getDiaryFilename(date) {
        return this._diaryFilenameTemplate.replace('{date}', date);
    }

    _getMonthlyFilename(yearMonth) {
        return this._monthlyFilenameTemplate.replace('{month}', yearMonth);
    }

    _getDiarySuffix() {
        return this._diaryFilenameTemplate.replace('{date}', '');
    }

    _readMonthlyDiaries(yearMonth) {
        if (!fs.existsSync(this._diaryFolder)) return null;

        const suffix = this._getDiarySuffix();
        const files = fs.readdirSync(this._diaryFolder)
            .filter(f => f.startsWith(yearMonth) && f.endsWith(suffix))
            .sort();

        if (files.length === 0) return null;

        this.context.log('info', `Month ${yearMonth} has ${files.length} AI journal entries`);

        return files.map(f => {
            const content = fs.readFileSync(path.join(this._diaryFolder, f), 'utf-8');
            const date = f.replace(suffix, '');
            return `=== ${date} journal ===\n${content}`;
        }).join('\n\n');
    }

    _saveDiaryFile(filename, content) {
        if (!fs.existsSync(this._diaryFolder)) {
            fs.mkdirSync(this._diaryFolder, { recursive: true });
        }
        const filePath = path.join(this._diaryFolder, filename);
        fs.writeFileSync(filePath, content, 'utf-8');
        this.context.log('info', `File saved: ${filePath}`);
        return filePath;
    }

    _updateCoreMemory(entryKey, content) {
        try {
            const timestamp = this._getTimestamp();
            const newEntry = `[${timestamp}] ${entryKey}：${content}\n`;

            let existing = '';
            if (fs.existsSync(this._coreMemoryPath)) {
                existing = fs.readFileSync(this._coreMemoryPath, 'utf-8');
            }

            const escapedKey = entryKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = new RegExp(
                `\\[\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\] ${escapedKey}[\\s\\S]*?(?=\\[\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\]|$)`
            );

            const final = pattern.test(existing)
                ? existing.replace(pattern, newEntry)
                : existing + newEntry;

            fs.writeFileSync(this._coreMemoryPath, final, 'utf-8');
            this.context.log('info', `Core memory updated: ${entryKey}`);
        } catch (error) {
            this.context.log('error', `Failed to update core memory: ${error.message}`);
        }
    }

    /**
     * 裁剪核心记忆中的日志：每日日志只保留最近一天，月度总结只保留最近一个月
     * 今天保留昨天，昨天没有则保留前天，以此类推
     */
    _pruneCoreMemoryLogs() {
        try {
            if (!fs.existsSync(this._coreMemoryPath)) return;

            const raw = fs.readFileSync(this._coreMemoryPath, 'utf-8');
            const chunks = raw.split(/(?=\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\])/).filter(Boolean);

            const dailyEntries = [];  // { key, date, fullText }
            const monthlyEntries = []; // { key, yearMonth, fullText }
            const otherEntries = [];   // 非本插件添加的条目

            for (const chunk of chunks) {
                const m = chunk.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] ([^：]+)：([\s\S]*)$/);
                if (!m) { otherEntries.push(chunk); continue; }

                const [, timestamp, key] = m;
                const fullText = chunk.replace(/\n+$/, '');

                const dailyDate = key.match(/^(\d{4}-\d{2}-\d{2})/);
                const monthlyYm = key.match(/^(\d{4}-\d{2})-[^\d]/);

                if (dailyDate) {
                    dailyEntries.push({ key, date: dailyDate[1], fullText });
                } else if (monthlyYm) {
                    monthlyEntries.push({ key, yearMonth: monthlyYm[1], fullText });
                } else {
                    otherEntries.push(chunk);
                }
            }

            dailyEntries.sort((a, b) => b.date.localeCompare(a.date));
            monthlyEntries.sort((a, b) => b.yearMonth.localeCompare(a.yearMonth));

            const keepDaily = dailyEntries[0] ? [dailyEntries[0].fullText] : [];
            const keepMonthly = monthlyEntries[0] ? [monthlyEntries[0].fullText] : [];

            const pruned = [...otherEntries, ...keepDaily, ...keepMonthly].join('\n\n');
            if (pruned !== raw) {
                fs.writeFileSync(this._coreMemoryPath, pruned, 'utf-8');
                const removed = dailyEntries.length + monthlyEntries.length - keepDaily.length - keepMonthly.length;
                if (removed > 0) {
                    this.context.log('info', `Core memory trimmed: kept the latest daily journal and the latest monthly summary, removed ${removed} old entries`);
                }
            }
        } catch (error) {
            this.context.log('error', `Failed to trim core memory: ${error.message}`);
        }
    }

    _backupAndClearHistory(date) {
        if (!this._historyBackupFolder) return;

        try {
            if (!fs.existsSync(this._conversationHistoryPath)) {
                this.context.log('warn', 'The memory log file does not exist, skipping the backup');
                return;
            }

            const content = fs.readFileSync(this._conversationHistoryPath, 'utf-8');
            if (!content.trim()) {
                this.context.log('info', 'The memory log is empty, skipping the backup');
                return;
            }

            if (!fs.existsSync(this._historyBackupFolder)) {
                fs.mkdirSync(this._historyBackupFolder, { recursive: true });
            }

            const now = new Date();
            const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
            const backupFilename = `记忆库-${date}-${timeStr}.txt`;
            const backupPath = path.join(this._historyBackupFolder, backupFilename);
            fs.writeFileSync(backupPath, content, 'utf-8');
            this.context.log('info', `Memory log backed up: ${backupPath}`);

            fs.writeFileSync(this._conversationHistoryPath, '', 'utf-8');
            this.context.log('info', 'Memory log cleared, ready for a new day');
        } catch (error) {
            this.context.log('error', `Memory log backup failed: ${error.message}`);
        }
    }

    // ===== 核心功能 =====

    _isInTriggerWindow() {
        const hour = new Date().getHours();
        return hour >= this._triggerAfterHour || hour < this._nightHourStart;
    }

    async _writeDiary(force = false, triggerReason) {
        const validReasons = ['user_requested', 'user_said_goodnight'];
        if (!triggerReason || !validReasons.includes(triggerReason)) {
            this.context.log('warn', `Invalid trigger reason: ${triggerReason}, refusing to run`);
            return 'The trigger reason is invalid or missing, so no journal was written. Only call this tool when the user explicitly asks for the journal or says good night or that they are going to sleep.';
        }

        if (triggerReason === 'user_said_goodnight' && !this._isInTriggerWindow()) {
            this.context.log('warn', `Good night trigger outside the time window (needs ${this._triggerAfterHour}:00-${this._nightHourStart}:00), refusing to run`);
            return `It's not journal time yet! Come back after ${this._triggerAfterHour}:00 tonight. If you really want to write it now, tell me clearly: "write the AI journal".`;
        }

        if (triggerReason === 'user_requested' && !force && !this._isInTriggerWindow()) {
            return `It's not journal time yet! Come back after ${this._triggerAfterHour}:00 tonight. If you really want to write it now, tell me clearly: "force write the AI journal".`;
        }

        this.context.log('info', `Writing the AI journal (trigger reason: ${triggerReason})...`);

        const date = this._getProperDate();
        const filename = this._getDiaryFilename(date);
        const diaryPath = path.join(this._diaryFolder, filename);

        let previousDiary = null;
        if (fs.existsSync(diaryPath)) {
            const existing = fs.readFileSync(diaryPath, 'utf-8').trim();
            if (existing) {
                previousDiary = existing;
                this.context.log('info', 'Today already has a journal, switching to "merge mode" to write a new version');
            }
        }

        const history = this._readConversationHistory();
        if (!history && !previousDiary) return 'There is no conversation history for today, so no AI journal can be written';

        let diaryContent;
        try {
            if (previousDiary) {
                diaryContent = await this._mergeDiary(previousDiary, history);
            } else {
                const userContent = `[Today's conversation history]\n${history}\n\nWrite today's AI journal based on the conversation history above.`;
                diaryContent = await this._callAPI(this._dailyPrompt, userContent);
            }
        } catch (error) {
            return `Failed to write the AI journal: ${error.message} (retried ${this._maxRetries} times)`;
        }

        const savedPath = this._saveDiaryFile(filename, diaryContent);
        const entryKey = filename.replace('.txt', '');
        this._updateCoreMemory(entryKey, diaryContent);
        this._pruneCoreMemoryLogs();

        this._backupAndClearHistory(date);

        this.context.log('info', 'AI journal finished');
        return `AI journal written and saved: ${savedPath}\n\n${diaryContent}`;
    }

    /**
     * 合并模式：今天已有日志、又要再写一次时调用。
     * 直接把"旧日志 + 原始对话"丢给主 prompt，LLM 会把对话当作主体重写，旧日志被覆盖。
     * 因此采用双调用：
     *   步骤 1 —— 用一个客观、中性的 prompt，把新对话提炼成"事件清单"（去掉噪音、保留事实）。
     *   步骤 2 —— 把"旧日志 + 事件清单"喂给附加了"合并模式"指令的主 prompt，强制旧日志事件 100% 保留、新事件以新增板块呈现。
     */
    async _mergeDiary(previousDiary, history) {
        if (!history) {
            this.context.log('info', 'The memory log is empty (no new conversation since the last journal), keeping the old journal as is');
            return previousDiary;
        }

        this.context.log('info', '[Merge mode 1/2] Extracting a list of events from the new conversation...');
        const extractSystemPrompt = `You extract events from conversations, objectively and neutrally.

Read the conversation history the user gives you and pull out the key events, what the user did, and the parts of the conversation worth recording.

Output rules:
- Use a list with one event per line. Start each line with "- " (dash and space)
- State the facts objectively: no emotional language, no role-play flourishes, no emotion tags
- Keep specific details (game names, error messages, the user's exact questions, key words from the conversation, and so on)
- If the conversation is scattered and really has no new events worth recording, output only this one line: (No new events worth recording)`;

        const newEvents = await this._callAPI(
            extractSystemPrompt,
            `Extract the events from this conversation history:\n\n${history}`
        );

        const trimmedEvents = (newEvents || '').trim();
        if (!trimmedEvents || /没有值得记录的新事件|no new events worth recording/i.test(trimmedEvents)) {
            this.context.log('info', 'The new conversation has nothing worth recording, keeping the old journal as is');
            return previousDiary;
        }

        this.context.log('info', '[Merge mode 2/2] Merging the new events into the old journal and writing the full version...');
        const mergeSystemPrompt = `${this._dailyPrompt}\n\n<merge_mode_override>\nUpdate the same-day AI diary. Preserve factual details from the old diary, merge new events naturally, avoid duplication, and output one coherent final version.\n</merge_mode_override>`;

        const mergeUserContent = `[Today's earlier journal (keep every event, section and detail in it)]
${previousDiary}

[New events since then (work them in as new sections or extra paragraphs)]
${trimmedEvents}

Output the final merged version of today's AI journal. Again: do not drop any event from the old journal, and add the new events naturally as new sections or extra paragraphs.`;

        return await this._callAPI(mergeSystemPrompt, mergeUserContent);
    }

    _readRecentDiary(days) {
        if (!fs.existsSync(this._diaryFolder)) return 'AI journal folder does not exist';

        const suffix = this._getDiarySuffix();
        const files = fs.readdirSync(this._diaryFolder)
            .filter(f => f.endsWith(suffix))
            .sort()
            .reverse()
            .slice(0, days);

        if (files.length === 0) return 'No AI journal entries found';

        let result = `AI journal of the last ${files.length} days:\n\n`;
        for (const f of files) {
            const content = fs.readFileSync(path.join(this._diaryFolder, f), 'utf-8');
            const date = f.replace(suffix, '');
            result += `=== ${date} ===\n${content}\n\n`;
        }
        return result;
    }

    async _writeMonthlySummary() {
        this.context.log('info', 'Writing the monthly summary...');

        const lastMonth = this._getLastMonth();
        const diaries = this._readMonthlyDiaries(lastMonth);
        if (!diaries) return `${lastMonth} has no AI journal entries, so no monthly summary can be written`;

        let summaryContent;
        try {
            summaryContent = await this._callAPI(
                this._monthlyPrompt,
                `Here are all the AI journal entries of this month. Write the monthly summary based on them:\n\n${diaries}`
            );
        } catch (error) {
            return `Failed to write the monthly summary: ${error.message} (retried ${this._maxRetries} times)`;
        }

        const filename = this._getMonthlyFilename(lastMonth);
        const savedPath = this._saveDiaryFile(filename, summaryContent);
        const entryKey = filename.replace('.txt', '');
        this._updateCoreMemory(entryKey, summaryContent);
        this._pruneCoreMemoryLogs();

        this.context.log('info', 'Monthly summary finished');
        return `${lastMonth} monthly summary written and saved: ${savedPath}\n\n${summaryContent}`;
    }
}

module.exports = AiLogPlugin;
