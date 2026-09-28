// plugin-manager.js - 插件管理器（支持热加载）
const fs = require('fs');
const path = require('path');
const { PluginContext } = require('./plugin-context.js');
const { logToTerminal, logToolAction } = require('../api-utils.js');

class PluginManager {
    constructor(config) {
        this._config = config;
        /** @type {Map<string, {plugin: Plugin, metadata: object, pluginDir: string}>} */
        this._plugins = new Map();
        /** 动态注册的工具（由 context.registerTool 调用）*/
        this._dynamicTools = new Map(); // pluginName -> toolDef[]

        this._pluginsDir = path.join(__dirname, '..', '..', 'plugins');
        this._builtinDir = path.join(__dirname, '..', '..', 'plugins', 'built-in');
        this._communityDir = path.join(__dirname, '..', '..', 'plugins', 'community');

        /** 已启用的插件相对路径集合，null 表示尚未加载 */
        this._enabledPlugins = null;

        /** 文件监听器引用 */
        this._enabledListWatcher = null;
        this._sourceWatchers = [];
        this._syncDebounceTimer = null;
        this._reloadDebounceTimers = new Map();
    }

    // ===== enabled_plugins.json 读取 =====

    /**
     * 从磁盘读取 enabled_plugins.json 并返回 Set
     * @param {boolean} [forceReload=false] - 是否强制从磁盘重新读取
     */
    _loadEnabledList(forceReload = false) {
        if (!forceReload && this._enabledPlugins !== null) return;

        const listPath = path.join(this._pluginsDir, 'enabled_plugins.json');
        if (!fs.existsSync(listPath)) {
            logToTerminal('warn', '⚠️ enabled_plugins.json not found, all plugins will be off');
            this._enabledPlugins = new Set();
            return;
        }
        try {
            const data = JSON.parse(fs.readFileSync(listPath, 'utf8'));
            this._enabledPlugins = new Set(
                (data.plugins || []).map(p => p.replace(/\\/g, '/'))
            );
        } catch (e) {
            logToTerminal('warn', `⚠️ enabled_plugins.json could not be read: ${e.message}`);
            this._enabledPlugins = new Set();
        }
    }

    /**
     * 扫描插件目录，返回 { relPath -> pluginDir } 映射
     */
    _scanAllPluginDirs() {
        const result = new Map();
        for (const baseDir of [this._builtinDir, this._communityDir]) {
            if (!fs.existsSync(baseDir)) continue;
            let entries;
            try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); } catch { continue; }
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const pluginDir = path.join(baseDir, entry.name);
                const metaPath = path.join(pluginDir, 'metadata.json');
                if (!fs.existsSync(metaPath)) continue;
                const relPath = path.relative(this._pluginsDir, pluginDir).replace(/\\/g, '/');
                result.set(relPath, pluginDir);
            }
        }
        return result;
    }

    // ===== 加载 =====

    async loadAll() {
        logToolAction('info', '🔌 Loading plugins...');
        await this._loadFromDir(this._builtinDir, 'built-in');
        await this._loadFromDir(this._communityDir, 'community');
        logToolAction('info', `🔌 Plugins loaded: ${this._plugins.size} plugins`);
    }

    async _loadFromDir(dir, type) {
        if (!fs.existsSync(dir)) return;

        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            logToTerminal('warn', `⚠️ Failed to read the plugin folder (${dir}): ${e.message}`);
            return;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const pluginDir = path.join(dir, entry.name);
            await this.load(pluginDir).catch(err => {
                logToolAction('error', `❌ Failed to load plugin (${entry.name}): ${err.message}`);
            });
        }
    }

    /**
     * 加载单个插件目录
     * @param {string} pluginDir - 插件目录绝对路径
     */
    async load(pluginDir) {
        const metaPath = path.join(pluginDir, 'metadata.json');
        if (!fs.existsSync(metaPath)) return;

        let metadata;
        try {
            metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        } catch (e) {
            throw new Error(`metadata.json could not be parsed: ${e.message}`);
        }

        const { name, main = 'index.js', lang } = metadata;

        this._loadEnabledList();
        const relPath = path.relative(this._pluginsDir, pluginDir).replace(/\\/g, '/');
        if (!this._enabledPlugins.has(relPath)) {
            //logToTerminal('info', `⏭️ 插件未启用，跳过: ${name}`);
            return;
        }

        if (this._plugins.has(relPath)) {
            //logToTerminal('info', `⏭️ 插件已加载，跳过: ${name}`);
            return;
        }

        const isPython = lang === 'python';
        const resolvedMain = main !== 'index.js' ? main : (isPython ? 'index.py' : 'index.js');
        const mainPath = path.join(pluginDir, resolvedMain);

        if (!fs.existsSync(mainPath)) {
            throw new Error(`Entry file not found: ${mainPath}`);
        }

        const context = new PluginContext(relPath, this._config, this, pluginDir);

        let plugin;
        if (isPython) {
            const { PythonPluginBridge } = require('./python-plugin-bridge.js');
            plugin = new PythonPluginBridge(metadata, context, mainPath);
        } else {
            let PluginClass;
            try {
                const mod = require(mainPath);
                PluginClass = mod.default || mod[Object.keys(mod)[0]] || mod;
            } catch (e) {
                throw new Error(`Failed to load the plugin module: ${e.message}`);
            }
            plugin = new PluginClass(metadata, context);
        }

        await plugin.onInit();

        this._plugins.set(relPath, { plugin, metadata, pluginDir });
        const displayName = metadata.displayName || name;
        logToolAction('info', `✅ Plugin loaded: ${displayName} v${metadata.version || '?'}${isPython ? ' [Python]' : ''}`);
    }

    /**
     * 卸载插件
     * @param {string} name
     */
    async unload(name) {
        const entry = this._plugins.get(name);
        if (!entry) return;

        await entry.plugin.onStop().catch(() => {});
        await entry.plugin.onDestroy().catch(() => {});
        this._plugins.delete(name);
        this._dynamicTools.delete(name);
        logToTerminal('info', `🔌 Plugin unloaded: ${name}`);
    }

    /**
     * 热重载插件（兼容 JS 和 Python 插件）
     * @param {string} name
     */
    async reload(name) {
        const entry = this._plugins.get(name);
        if (!entry) throw new Error(`Plugin not found: ${name}`);

        const { pluginDir, metadata } = entry;

        await this.unload(name);

        if (metadata.lang !== 'python') {
            const mainPath = path.join(pluginDir, metadata.main || 'index.js');
            try { delete require.cache[require.resolve(mainPath)]; } catch {}
        }

        await this.load(pluginDir);
        const newEntry = this._plugins.get(name);
        if (newEntry) await newEntry.plugin.onStart();

        logToTerminal('info', `🔄 Plugin hot-reloaded: ${name}`);
    }

    /**
     * 重载所有已加载的插件
     */
    async reloadAll() {
        const names = Array.from(this._plugins.keys());
        for (const name of names) {
            try {
                await this.reload(name);
            } catch (e) {
                logToTerminal('error', `❌ Hot reload failed (${name}): ${e.message}`);
            }
        }
    }

    /**
     * 同步 enabled_plugins.json 的变更：加载新启用的、卸载被禁用的
     */
    async syncEnabledPlugins() {
        logToTerminal('info', '🔄 The enabled plugin list changed, syncing...');

        this._loadEnabledList(true);

        const allDirs = this._scanAllPluginDirs();
        const enabledRelPaths = this._enabledPlugins;

        const currentlyLoaded = new Map();
        for (const [name, entry] of this._plugins) {
            const relPath = path.relative(this._pluginsDir, entry.pluginDir).replace(/\\/g, '/');
            currentlyLoaded.set(relPath, name);
        }

        // 卸载被禁用的插件
        for (const [relPath, name] of currentlyLoaded) {
            if (!enabledRelPaths.has(relPath)) {
                try {
                    await this.unload(name);
                    logToTerminal('info', `🔌 Plugin unloaded because it was turned off: ${name}`);
                } catch (e) {
                    logToTerminal('error', `❌ Failed to unload plugin (${name}): ${e.message}`);
                }
            }
        }

        // 加载新启用的插件
        for (const relPath of enabledRelPaths) {
            if (currentlyLoaded.has(relPath)) continue;
            const pluginDir = allDirs.get(relPath);
            if (!pluginDir) continue;
            try {
                await this.load(pluginDir);
                const metaPath = path.join(pluginDir, 'metadata.json');
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                const newEntry = this._plugins.get(relPath);
                if (newEntry) await newEntry.plugin.onStart();
                logToTerminal('info', `🔌 Plugin loaded because it was turned on: ${meta.name}`);
            } catch (e) {
                logToTerminal('error', `❌ Failed to load the newly enabled plugin (${relPath}): ${e.message}`);
            }
        }

        logToTerminal('info', `🔌 Plugin sync done, now ${this._plugins.size} plugins`);
    }

    /**
     * 获取所有插件信息列表（供 API 使用）
     */
    getPluginList() {
        const list = [];
        for (const [id, { metadata, pluginDir }] of this._plugins) {
            list.push({
                id,
                name: id,
                pluginName: metadata.name || path.basename(pluginDir),
                displayName: metadata.displayName || metadata.name || path.basename(pluginDir),
                version: metadata.version || '?',
                lang: metadata.lang || 'js',
                dir: pluginDir,
            });
        }
        return list;
    }

    // ===== 文件监听（热加载）=====

    startWatching() {
        this._watchEnabledList();
        this._watchSourceFiles();
        logToTerminal('info', '👁️ Plugin hot-reload watcher started');
    }

    stopWatching() {
        if (this._enabledListWatcher) {
            this._enabledListWatcher.close();
            this._enabledListWatcher = null;
        }
        for (const w of this._sourceWatchers) {
            w.close();
        }
        this._sourceWatchers = [];
        clearTimeout(this._syncDebounceTimer);
        for (const t of this._reloadDebounceTimers.values()) clearTimeout(t);
        this._reloadDebounceTimers.clear();
        logToTerminal('info', '👁️ Plugin hot-reload watcher stopped');
    }

    /**
     * 监听 enabled_plugins.json，肥牛.exe 修改后自动同步
     */
    _watchEnabledList() {
        const listPath = path.join(this._pluginsDir, 'enabled_plugins.json');
        if (!fs.existsSync(listPath)) return;

        try {
            this._enabledListWatcher = fs.watch(listPath, () => {
                clearTimeout(this._syncDebounceTimer);
                this._syncDebounceTimer = setTimeout(() => {
                    this.syncEnabledPlugins().catch(e => {
                        logToTerminal('error', `❌ Failed to sync the enabled plugin list: ${e.message}`);
                    });
                }, 500);
            });
        } catch (e) {
            logToTerminal('warn', `⚠️ Cannot watch enabled_plugins.json: ${e.message}`);
        }
    }

    /**
     * 监听插件源码文件变更，自动重载对应插件
     */
    _watchSourceFiles() {
        for (const baseDir of [this._builtinDir, this._communityDir]) {
            if (!fs.existsSync(baseDir)) continue;
            try {
                const watcher = fs.watch(baseDir, { recursive: true }, (eventType, filename) => {
                    if (!filename) return;
                    const ext = path.extname(filename).toLowerCase();
                    if (ext !== '.js' && ext !== '.py') return;

                    const parts = filename.replace(/\\/g, '/').split('/');
                    if (parts.length < 1) return;
                    const pluginFolderName = parts[0];

                    const source = baseDir === this._builtinDir ? 'built-in' : 'community';
                    const targetName = `${source}/${pluginFolderName}`;
                    if (!this._plugins.has(targetName)) return;

                    clearTimeout(this._reloadDebounceTimers.get(targetName));
                    this._reloadDebounceTimers.set(targetName, setTimeout(() => {
                        this._reloadDebounceTimers.delete(targetName);
                        logToTerminal('info', `👁️ Source changed: ${filename}, reloading plugin ${targetName}`);
                        this.reload(targetName).catch(e => {
                            logToTerminal('error', `❌ Hot reload after a source change failed (${targetName}): ${e.message}`);
                        });
                    }, 500));
                });
                this._sourceWatchers.push(watcher);
            } catch (e) {
                logToTerminal('warn', `⚠️ Cannot watch the plugin source folder (${baseDir}): ${e.message}`);
            }
        }
    }

    _findPluginDir(name) {
        const entry = this._plugins.get(name);
        if (entry) return entry.pluginDir;
        for (const loaded of this._plugins.values()) {
            if (loaded.metadata.name === name || path.basename(loaded.pluginDir) === name) {
                return loaded.pluginDir;
            }
        }
        for (const baseDir of [this._builtinDir, this._communityDir]) {
            const dir = path.join(baseDir, name);
            if (fs.existsSync(dir)) return dir;
        }
        return null;
    }

    // ===== 查询 =====

    getPlugin(name) {
        const exact = this._plugins.get(name);
        if (exact) return exact.plugin;
        for (const entry of this._plugins.values()) {
            if (entry.metadata.name === name || path.basename(entry.pluginDir) === name) {
                return entry.plugin;
            }
        }
        return null;
    }

    getAllPlugins() {
        return Array.from(this._plugins.values()).map(e => e.plugin);
    }

    // ===== 启动 / 停止所有插件 =====

    async startAll() {
        for (const [name, { plugin }] of this._plugins) {
            try {
                await plugin.onStart();
            } catch (e) {
                logToTerminal('error', `❌ Plugin onStart failed (${name}): ${e.message}`);
            }
        }
    }

    async stopAll() {
        for (const [name, { plugin }] of this._plugins) {
            try {
                await plugin.onStop();
            } catch (e) {
                logToTerminal('error', `❌ Plugin onStop failed (${name}): ${e.message}`);
            }
        }
    }

    // ===== 流水线 Hook 执行 =====

    /**
     * 执行所有插件的 onUserInput 钩子
     * @param {MessageEvent} event
     */
    async runUserInputHooks(event) {
        for (const [name, { plugin }] of this._plugins) {
            if (event._stopped) break;
            try {
                await plugin.onUserInput(event);
            } catch (e) {
                logToTerminal('error', `❌ onUserInput plugin error (${name}): ${e.message}`);
            }
        }
    }

    /**
     * 执行所有插件的 onLLMRequest 钩子
     * @param {object} request - { messages, tools }
     */
    async runLLMRequestHooks(request) {
        for (const [name, { plugin }] of this._plugins) {
            try {
                await plugin.onLLMRequest(request);
            } catch (e) {
                logToTerminal('error', `❌ onLLMRequest plugin error (${name}): ${e.message}`);
            }
        }
    }

    /**
     * 执行所有插件的 onLLMResponse 钩子
     * @param {object} response - { text }
     */
    async runLLMResponseHooks(response) {
        for (const [name, { plugin }] of this._plugins) {
            try {
                await plugin.onLLMResponse(response);
            } catch (e) {
                logToTerminal('error', `❌ onLLMResponse plugin error (${name}): ${e.message}`);
            }
        }
    }

    /**
     * 执行所有插件的 onTTSText 钩子，允许插件修改送入 TTS 的文本
     * @param {string} text
     * @returns {Promise<string>} 最终文本
     */
    async runTTSTextHooks(text) {
        let result = text;
        for (const [name, { plugin }] of this._plugins) {
            try {
                const modified = await plugin.onTTSText(result);
                if (typeof modified === 'string') result = modified;
            } catch (e) {
                logToTerminal('error', `❌ onTTSText plugin error (${name}): ${e.message}`);
            }
        }
        return result;
    }

    /**
     * 执行所有插件的 onTTSStart 钩子
     * @param {string} text
     */
    async runTTSStartHooks(text) {
        for (const [name, { plugin }] of this._plugins) {
            try {
                await plugin.onTTSStart(text);
            } catch (e) {
                logToTerminal('error', `❌ onTTSStart plugin error (${name}): ${e.message}`);
            }
        }
    }

    /** 执行所有插件的 onTTSEnd 钩子 */
    async runTTSEndHooks() {
        for (const [name, { plugin }] of this._plugins) {
            try {
                await plugin.onTTSEnd();
            } catch (e) {
                logToTerminal('error', `❌ onTTSEnd plugin error (${name}): ${e.message}`);
            }
        }
    }

    // ===== 工具聚合 =====

    /**
     * 合并所有插件提供的工具列表
     * @returns {Array}
     */
    getAllTools() {
        const tools = [];
        for (const [, { plugin }] of this._plugins) {
            try {
                const pluginTools = plugin.getTools();
                if (Array.isArray(pluginTools)) {
                    tools.push(...pluginTools);
                }
            } catch (e) {
                // 忽略单个插件错误
            }
        }
        // 追加动态注册的工具
        for (const toolList of this._dynamicTools.values()) {
            tools.push(...toolList);
        }
        return tools;
    }

    /**
     * 路由工具调用到对应插件
     * @param {string} name - 工具名
     * @param {object} params
     * @returns {Promise<string>}
     */
    async executeTool(name, params) {
        for (const [, { plugin }] of this._plugins) {
            const tools = plugin.getTools ? plugin.getTools() : [];
            // 兼容两种格式：{ name } 和 { function: { name } }
            if (tools.some(t => t.name === name || t.function?.name === name)) {
                return await plugin.executeTool(name, params);
            }
        }
        throw new Error(`No plugin provides the tool: ${name}`);
    }

    /**
     * 动态注册工具（由 PluginContext 调用）
     * @param {string} pluginName
     * @param {object} toolDef
     */
    registerDynamicTool(pluginName, toolDef) {
        if (!this._dynamicTools.has(pluginName)) {
            this._dynamicTools.set(pluginName, []);
        }
        const list = this._dynamicTools.get(pluginName);
        // 去重
        if (!list.some(t => t.name === toolDef.name)) {
            list.push(toolDef);
        }
    }
}

module.exports = { PluginManager };
