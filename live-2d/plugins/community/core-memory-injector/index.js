const { Plugin } = require('../../../js/core/plugin-base.js');
const fs = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, '..', '..', '..', 'AI记录室', '核心用户记忆.txt');

class CoreMemoryInjector extends Plugin {

    async onInit() {
        this._watcher = null;
        this._cachedMemory = null;
    }

    async onStart() {
        this._loadMemory();
        this._watchFile();
        this.context.log('info', `Core memory injector started, watching the file: ${MEMORY_FILE}`);
    }

    async onStop() {
        this._unwatchFile();
        this._cachedMemory = null;
    }

    /**
     * 每次 LLM 请求前，将核心记忆注入到 system 消息中。
     * 操作的是 deep copy 的 messagesForAPI，不会污染持久化的 messages。
     */
    async onLLMRequest(request) {
        if (!this._cachedMemory) return;

        const sysMsg = request.messages.find(m => m.role === 'system');
        if (sysMsg) {
            sysMsg.content += `\n\n[Core user memory - always remember the following]\n${this._cachedMemory}`;
        }
    }

    // ===== 工具注册 =====

    getTools() {
        return [
            {
                type: 'function',
                function: {
                    name: 'core_memory_write',
                    description: 'Write important information to core memory. Use it when the user says "write this to core memory", "put it in your core memory", "remember this forever" and so on. Core memory is permanent memory with the highest priority. It is loaded in every conversation.',
                    parameters: {
                        type: 'object',
                        properties: {
                            content: { type: 'string', description: 'What to write to core memory. Sum up the information briefly and accurately' }
                        },
                        required: ['content']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'core_memory_list',
                    description: 'List all current core memory entries. Check them before writing a new one, to avoid duplicates.',
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
        switch (name) {
            case 'core_memory_write':
                return this._writeMemory(params.content);
            case 'core_memory_list':
                return this._listMemories();
            default:
                return undefined;
        }
    }

    // ===== 工具执行 =====

    _writeMemory(content) {
        if (!content) return 'Error: nothing to write was given.';
        try {
            const dir = path.dirname(MEMORY_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const timestamp = this._getTimestamp();
            const entry = `[${timestamp}] ${content}\n`;
            fs.appendFileSync(MEMORY_FILE, entry, 'utf-8');
            this._loadMemory();
            this.context.log('info', `Written to core memory: ${content}`);
            return `Saved to core memory: ${content}`;
        } catch (e) {
            this.context.log('error', `Failed to write core memory: ${e.message}`);
            return `Failed to write core memory: ${e.message}`;
        }
    }

    _listMemories() {
        try {
            if (!fs.existsSync(MEMORY_FILE)) return 'There is no core memory yet.';
            const raw = fs.readFileSync(MEMORY_FILE, 'utf-8').trim();
            if (!raw) return 'There is no core memory yet.';

            const entries = raw.split(/\n+/).filter(line => line.trim());
            if (entries.length === 0) return 'There is no core memory yet.';

            const list = entries.map((entry, i) => `${i + 1}. ${entry}`).join('\n');
            return `There are ${entries.length} core memory entries:\n${list}`;
        } catch (e) {
            return `Failed to read core memory: ${e.message}`;
        }
    }

    _getTimestamp() {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }

    // ===== 记忆文件读取与监听 =====

    _loadMemory() {
        try {
            if (!fs.existsSync(MEMORY_FILE)) {
                this.context.log('warn', '核心用户记忆.txt does not exist, not loading it');
                this._cachedMemory = null;
                return;
            }
            const raw = fs.readFileSync(MEMORY_FILE, 'utf-8').trim();
            if (!raw) {
                this.context.log('warn', '核心用户记忆.txt is empty, not loading it');
                this._cachedMemory = null;
                return;
            }
            this._cachedMemory = raw;
            this.context.log('info', `Core memory loaded, length: ${raw.length} characters`);
        } catch (e) {
            this.context.log('error', `Failed to read core memory: ${e.message}`);
            this._cachedMemory = null;
        }
    }

    _watchFile() {
        try {
            const dir = path.dirname(MEMORY_FILE);
            const base = path.basename(MEMORY_FILE);
            this._watcher = fs.watch(dir, (eventType, filename) => {
                if (filename === base) {
                    clearTimeout(this._debounce);
                    this._debounce = setTimeout(() => {
                        this.context.log('info', 'The core memory file changed, reloading...');
                        this._loadMemory();
                    }, 1000);
                }
            });
        } catch (e) {
            this.context.log('warn', `Cannot watch the memory file for changes: ${e.message}`);
        }
    }

    _unwatchFile() {
        if (this._watcher) {
            this._watcher.close();
            this._watcher = null;
        }
        clearTimeout(this._debounce);
    }
}

module.exports = CoreMemoryInjector;
