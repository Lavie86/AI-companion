const axios = require('axios');
const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// ==================== 工具定义 ====================

const TOOL_DEFINITIONS = [
    {
        name: 'memos_search_memory',
        description: "Search your long-term memory in depth for related past information and conversations. You must use this tool when the user asks about past events, with phrases like 'do you remember', 'you said before', 'last time', 'back then', 'did we ever', 'remember when' and so on! You can also use it on your own to look up the user's preferences, experiences, plans you agreed on and so on.",
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: "The search query. [Important] Use a full natural-language sentence, not a single word! For example: 'what food does the user like', 'which games has the user played', 'memories about fried skewers'." },
                top_k: { type: 'integer', description: 'How many of the most relevant memories to return. Default: 5' }
            },
            required: ['query']
        }
    },
    {
        name: 'memos_add_memory',
        description: "Add important information to your long-term memory. Use it when the user explicitly says 'remember this', 'don't forget', 'make a note of this', 'keep this in mind' and so on. You can also use it on your own to record important things the user tells you (such as birthdays, likes and dislikes, important events).",
        parameters: {
            type: 'object',
            properties: {
                content: { type: 'string', description: 'What to remember. Keep it short and clear' }
            },
            required: ['content']
        }
    },
    {
        name: 'memos_upload_image',
        description: "Save an image to your long-term memory. Use it when the user says 'remember this picture', 'save this image' and so on.",
        parameters: {
            type: 'object',
            properties: {
                image_base64: { type: 'string', description: 'The image as base64 data (without the data:image/xxx;base64, prefix)' },
                description: { type: 'string', description: 'A description or title of the image, used to find it later' },
                image_type: { type: 'string', description: 'Image type: screenshot, photo, artwork, document or other', enum: ['screenshot', 'photo', 'artwork', 'document', 'other'] },
                tags: { type: 'array', items: { type: 'string' }, description: 'Tags for the image, used to sort and search' }
            },
            required: ['image_base64', 'description']
        }
    },
    {
        name: 'memos_search_images',
        description: "Search your image memory for related images. Use it when the user asks things like 'where's that picture from before', 'find the cat pictures' and so on.",
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'The search query: describe what is in the image you want' },
                image_type: { type: 'string', description: 'Optional. Only this image type', enum: ['screenshot', 'photo', 'artwork', 'document', 'other'] },
                top_k: { type: 'integer', description: 'How many to return. Default: 5' }
            },
            required: ['query']
        }
    },
    {
        name: 'memos_save_screenshot',
        description: "Take a screenshot and save it to your long-term memory. Use it when the user says 'remember what's on my screen', 'save this screenshot' and so on. The tool takes the screenshot and saves it by itself.",
        parameters: {
            type: 'object',
            properties: {
                description: { type: 'string', description: '[Required] A description or title of the screenshot, used to find and recognize it later' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Tags for the screenshot, used to sort and search' }
            },
            required: ['description']
        }
    },
    {
        name: 'memos_save_image_from_file',
        description: "Save an image file from the computer to your long-term memory. Supports common image formats such as JPG, PNG, GIF and WEBP.",
        parameters: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: '[Required] The full path of the image file' },
                description: { type: 'string', description: '[Required] A description or title of the image' },
                image_type: { type: 'string', description: 'Image type', enum: ['photo', 'artwork', 'document', 'screenshot', 'other'] },
                tags: { type: 'array', items: { type: 'string' }, description: 'Tags for the image' }
            },
            required: ['file_path', 'description']
        }
    },
    {
        name: 'memos_record_tool_usage',
        description: 'Record a tool use in the memory system. Call it on your own after important tool calls so you can look back on them later.',
        parameters: {
            type: 'object',
            properties: {
                tool_name: { type: 'string', description: 'Tool name' },
                parameters: { type: 'object', description: 'The parameters used for the tool call' },
                result_summary: { type: 'string', description: 'A short summary of the tool\'s result' },
                category: { type: 'string', description: 'Tool category', enum: ['search', 'media', 'utility', 'game', 'other'] }
            },
            required: ['tool_name', 'result_summary']
        }
    },
    {
        name: 'memos_search_tool_usage',
        description: "Search the records of earlier tool use. Use it when the user asks things like 'what did you search for before', 'the song you played last time' and so on.",
        parameters: {
            type: 'object',
            properties: {
                tool_name: { type: 'string', description: 'Optional. Only this tool name' },
                keyword: { type: 'string', description: 'Optional. A search keyword' },
                limit: { type: 'integer', description: 'How many to return. Default: 10' }
            },
            required: []
        }
    },
    {
        name: 'memos_import_url',
        description: "Import a web page into your long-term memory. Use it when the user says 'remember this web page', 'save this link' and so on.",
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'The URL of the web page to import (starts with http or https)' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags, used to sort and search later' }
            },
            required: ['url']
        }
    },
    {
        name: 'memos_import_document',
        description: "Import a document into your long-term memory. Supports txt, pdf and md.",
        parameters: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Local path of the document (.txt, .pdf or .md)' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags, used to sort' }
            },
            required: ['file_path']
        }
    },
    {
        name: 'memos_correct_memory',
        description: "Correct, add to or delete an existing memory. First find the memory ID with memos_search_memory.",
        parameters: {
            type: 'object',
            properties: {
                memory_id: { type: 'string', description: 'ID of the memory to change (get it from a search)' },
                action: { type: 'string', description: 'What to do', enum: ['correct', 'supplement', 'delete'] },
                new_content: { type: 'string', description: 'The corrected content, or the content to add (not needed for delete)' },
                reason: { type: 'string', description: 'Optional. Why you are changing or deleting it' }
            },
            required: ['memory_id', 'action']
        }
    },
    {
        name: 'memos_get_preferences',
        description: "Get a summary and a detailed list of the user's preferences. Use it when recommending food, music and so on. It also answers questions like 'what do I like'.",
        parameters: {
            type: 'object',
            properties: {
                category: { type: 'string', description: 'Optional. Only show preferences in this category', enum: ['food', 'music', 'game', 'movie', 'hobby', 'style', 'schedule', 'general'] },
                include_details: { type: 'boolean', description: 'Whether to include the detailed list of preferences. Default: true' }
            },
            required: []
        }
    }
];

// ==================== 工具执行 ====================

class MemosTools {
    constructor(apiUrl, options = {}) {
        this.apiUrl = apiUrl;
        this.similarityThreshold = options.similarityThreshold ?? 0.6;
    }

    getDefinitions() {
        return TOOL_DEFINITIONS.map(def => ({
            type: 'function',
            function: {
                name: def.name,
                description: def.description,
                parameters: def.parameters
            }
        }));
    }

    async execute(name, params) {
        const handler = this._handlers[name];
        if (!handler) throw new Error(`[MemOS] Unsupported function: ${name}`);
        return handler.call(this, params);
    }

    get _handlers() {
        return {
            memos_search_memory: this._searchMemory,
            memos_add_memory: this._addMemory,
            memos_upload_image: this._uploadImage,
            memos_search_images: this._searchImages,
            memos_save_screenshot: this._saveScreenshot,
            memos_save_image_from_file: this._saveImageFromFile,
            memos_record_tool_usage: this._recordToolUsage,
            memos_search_tool_usage: this._searchToolUsage,
            memos_import_url: this._importUrl,
            memos_import_document: this._importDocument,
            memos_correct_memory: this._correctMemory,
            memos_get_preferences: this._getPreferences,
        };
    }

    // ---------- helpers ----------

    _formatTime(ts) {
        if (!ts) return '';
        try {
            const d = new Date(ts);
            if (isNaN(d.getTime())) return typeof ts === 'string' ? ts : String(ts);
            return d.toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            });
        } catch (_) {
            return typeof ts === 'string' ? ts : String(ts);
        }
    }

    _connRefused(error) {
        return error.code === 'ECONNREFUSED' ? 'The memory service is not running.' : null;
    }

    // ---------- 基础记忆 ----------

    async _searchMemory({ query, top_k = 5 }) {
        if (!query) return 'Error: no search query (query) was given.';
        try {
            const { data } = await axios.post(`${this.apiUrl}/search`, {
                query, top_k, user_id: 'feiniu_default',
                similarity_threshold: this.similarityThreshold
            }, { timeout: 5000 });
            const memories = data.memories || [];
            if (memories.length === 0) return `Found nothing in memory about "${query}".`;

            const lines = memories.map((mem, i) => {
                const content = typeof mem === 'string' ? mem : mem.content;
                const pl = mem && typeof mem.payload === 'object' && mem.payload ? mem.payload : null;
                const rawCreated = mem.created_at || mem.timestamp || (pl && (pl.created_at || pl.timestamp));
                const rawUpdated = mem.updated_at || (pl && pl.updated_at);
                const timeStr = this._formatTime(rawCreated);
                const updateMark = (rawUpdated && rawUpdated !== rawCreated) ? ' (updated)' : '';
                const idTag = mem.id ? ` [ID: ${mem.id}]` : '';
                return timeStr ? `${i + 1}. ${content} [${timeStr}]${updateMark}${idTag}` : `${i + 1}. ${content}${idTag}`;
            });
            return `Found ${memories.length} related memories:\n${lines.join('\n')}`;
        } catch (error) {
            return this._connRefused(error) || `Error while searching memories: ${error.message}`;
        }
    }

    async _addMemory({ content }) {
        if (!content) return 'Error: nothing to remember (content) was given.';
        try {
            await axios.post(`${this.apiUrl}/add`, { messages: [{ role: 'user', content }], user_id: 'feiniu_default' }, { timeout: 60000 });
            return `Remembered: ${content}`;
        } catch (error) {
            return this._connRefused(error) || `Error while adding the memory: ${error.message}`;
        }
    }

    // ---------- 图片记忆 ----------

    async _uploadImage({ image_base64, description, image_type = 'other', tags = [] }) {
        if (!image_base64) return 'Error: no image data (image_base64) was given.';
        if (!description) return 'Error: no image description (description) was given.';
        try {
            const { data } = await axios.post(`${this.apiUrl}/images/upload`, { image_base64, description, image_type, tags, user_id: 'feiniu_default' }, { timeout: 30000 });
            return `Saved the image “${description}”, image ID: ${data.image_id || 'created'}`;
        } catch (error) {
            return this._connRefused(error) || `Error while saving the image: ${error.message}`;
        }
    }

    async _searchImages({ query, image_type, top_k = 5 }) {
        if (!query) return 'Error: no search query (query) was given.';
        try {
            const reqData = { query, top_k, user_id: 'feiniu_default' };
            if (image_type) reqData.image_type = image_type;
            const { data } = await axios.post(`${this.apiUrl}/images/search`, reqData, { timeout: 10000 });
            const images = data.images || [];
            if (images.length === 0) return `No image memories found for “${query}”.`;

            const lines = images.map((img, i) => {
                const desc = img.description || 'no description';
                const type = img.image_type || 'unknown';
                const time = img.created_at ? new Date(img.created_at).toLocaleDateString('zh-CN') : '';
                const t = img.tags?.length > 0 ? `[${img.tags.join(', ')}]` : '';
                return `${i + 1}. [${type}] ${desc} ${t}${time ? ` (${time})` : ''}`;
            });
            return `Found ${images.length} related images:\n${lines.join('\n')}`;
        } catch (error) {
            return this._connRefused(error) || `Error while searching images: ${error.message}`;
        }
    }

    async _saveScreenshot({ description, tags = [] }) {
        if (!description) return 'Error: no screenshot description (description) was given.';
        try {
            const base64Image = await ipcRenderer.invoke('take-screenshot');
            if (!base64Image) return 'Error: the screenshot failed, could not capture the screen.';

            const { data } = await axios.post(`${this.apiUrl}/images/upload`, {
                image_base64: base64Image, description, image_type: 'screenshot', tags, user_id: 'feiniu_default'
            }, { timeout: 30000 });
            return `Took a screenshot and saved it to memory!\nDescription: ${description}\nImage ID: ${data.image_id || 'created'}`;
        } catch (error) {
            if (error.message?.includes('invoke')) return 'Screenshots are not available, possibly a problem with the Electron environment.';
            return this._connRefused(error) || `Error while saving the screenshot: ${error.message}`;
        }
    }

    async _saveImageFromFile({ file_path, description, image_type = 'photo', tags = [] }) {
        if (!file_path) return 'Error: no image file path (file_path) was given.';
        if (!description) return 'Error: no image description (description) was given.';
        try {
            if (!fs.existsSync(file_path)) return `Error: file not found: ${file_path}`;
            const ext = path.extname(file_path).toLowerCase();
            const supported = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
            if (!supported.includes(ext)) return `Error: unsupported image format (${ext}). Supported: ${supported.join(', ')}`;

            const imageBuffer = fs.readFileSync(file_path);
            const base64Image = imageBuffer.toString('base64');
            const filename = path.basename(file_path);

            const { data } = await axios.post(`${this.apiUrl}/images/upload`, {
                image_base64: base64Image, filename, description, image_type, tags, user_id: 'feiniu_default'
            }, { timeout: 30000 });
            return `Saved the image to memory!\nFile: ${filename}\nDescription: ${description}\nImage ID: ${data.image_id || 'created'}`;
        } catch (error) {
            if (error.code === 'ENOENT') return `Error: cannot read the file: ${file_path}`;
            return this._connRefused(error) || `Error while saving the image: ${error.message}`;
        }
    }

    // ---------- 工具使用记录 ----------

    async _recordToolUsage({ tool_name, parameters: toolParams = {}, result_summary, category = 'other' }) {
        if (!tool_name) return 'Error: no tool name (tool_name) was given.';
        if (!result_summary) return 'Error: no result summary (result_summary) was given.';
        try {
            await axios.post(`${this.apiUrl}/tools/record`, { tool_name, parameters: toolParams, result_summary, category, user_id: 'feiniu_default' }, { timeout: 5000 });
            return `Recorded the use of tool “${tool_name}”`;
        } catch (error) {
            return this._connRefused(error) || `Error while recording the tool use: ${error.message}`;
        }
    }

    async _searchToolUsage({ tool_name, keyword, limit = 10 }) {
        try {
            const { data } = await axios.get(`${this.apiUrl}/tools/recent`, { params: { tool_name: tool_name || undefined, limit }, timeout: 5000 });
            let records = data.records || [];
            if (keyword && records.length > 0) {
                const kw = keyword.toLowerCase();
                records = records.filter(r =>
                    r.tool_name?.toLowerCase().includes(kw) ||
                    r.result_summary?.toLowerCase().includes(kw) ||
                    (r.parameters && JSON.stringify(r.parameters).toLowerCase().includes(kw))
                );
            }
            if (records.length === 0) {
                const hints = [tool_name && `tool “${tool_name}”`, keyword && `keyword “${keyword}”`].filter(Boolean);
                return hints.length > 0 ? `No tool use records match ${hints.join(', ')}.` : 'No tool use records found.';
            }

            const lines = records.map((r, i) => {
                const name = r.tool_name || 'unknown';
                const summary = r.result_summary || 'no summary';
                const time = r.timestamp ? new Date(r.timestamp).toLocaleString('zh-CN') : '';
                let p = '';
                if (r.parameters) {
                    const paramStr = JSON.stringify(r.parameters);
                    p = paramStr.length > 50 ? ` (parameters: ${paramStr.substring(0, 50)}...)` : ` (parameters: ${paramStr})`;
                }
                return `${i + 1}. [${name}] ${summary}${p}${time ? ` - ${time}` : ''}`;
            });
            return `Found ${records.length} tool use records:\n${lines.join('\n')}`;
        } catch (error) {
            return this._connRefused(error) || `Error while searching the tool records: ${error.message}`;
        }
    }

    // ---------- 知识库导入 ----------

    async _importUrl({ url, tags = [] }) {
        if (!url) return 'Error: no web page URL was given.';
        if (!url.startsWith('http://') && !url.startsWith('https://')) return 'Error: the URL must start with http:// or https://.';
        try {
            const { data } = await axios.post(`${this.apiUrl}/kb/import`, { source: url, tags: ['web', ...tags], user_id: 'feiniu_default' }, { timeout: 60000 });
            if (data.status === 'success') return `Imported the web page!\n- URL: ${url}\n- Chunks: ${data.chunks_count || 0}\n- Memories imported: ${data.imported_count || 0}`;
            return `Import failed: ${data.message || 'unknown error'}`;
        } catch (error) {
            if (error.response?.status === 503) return 'The document loader is not initialized, so the web page cannot be imported.';
            return this._connRefused(error) || `Error while importing the web page: ${error.message}`;
        }
    }

    async _importDocument({ file_path, tags = [] }) {
        if (!file_path) return 'Error: no document path was given.';
        try {
            if (!file_path.startsWith('http://') && !file_path.startsWith('https://')) {
                if (!fs.existsSync(file_path)) return `Error: file not found: ${file_path}`;
                const ext = path.extname(file_path).toLowerCase();
                const supported = ['.txt', '.pdf', '.md'];
                if (!supported.includes(ext)) return `Error: unsupported document format (${ext}). Supported: ${supported.join(', ')}`;
            }
            const { data } = await axios.post(`${this.apiUrl}/kb/import`, { source: file_path, tags: ['document', ...tags], user_id: 'feiniu_default' }, { timeout: 120000 });
            if (data.status === 'success') return `Imported the document!\n- Path: ${file_path}\n- Chunks: ${data.chunks_count || 0}\n- Memories imported: ${data.imported_count || 0}`;
            return `Import failed: ${data.message || 'unknown error'}`;
        } catch (error) {
            if (error.response?.status === 503) return 'The document loader is not initialized, so the document cannot be imported.';
            return this._connRefused(error) || `Error while importing the document: ${error.message}`;
        }
    }

    // ---------- 记忆修正 ----------

    async _correctMemory({ memory_id, action, new_content, reason }) {
        if (!memory_id) return 'Error: no memory ID was given. Search with memos_search_memory first to get the memory ID.';
        if (!action) return 'Error: no action was given. Choose correct, supplement or delete';
        if ((action === 'correct' || action === 'supplement') && !new_content) {
            return `Error: the ${action === 'correct' ? 'correct' : 'supplement'} action needs new_content.`;
        }
        try {
            const reqData = { memory_id, feedback_type: action, reason: reason || '', user_id: 'feiniu_default' };
            if (action === 'correct' || action === 'supplement') reqData.correction = new_content;

            const { data } = await axios.post(`${this.apiUrl}/memory/feedback`, reqData, { timeout: 10000 });
            if (data.status === 'success') {
                const actionName = { correct: 'corrected', supplement: 'added to', delete: 'deleted' }[action] || action;
                if (action === 'delete') return `Deleted the memory (ID: ${memory_id})`;
                return `Successfully ${actionName} the memory!\n- ID: ${memory_id}\n- New content: ${data.new_content || new_content}`;
            }
            return `Action failed: ${data.message || 'unknown error'}`;
        } catch (error) {
            if (error.response?.status === 404) return `Memory ID “${memory_id}” does not exist. Check that the ID is right.`;
            return this._connRefused(error) || `Error while changing the memory: ${error.message}`;
        }
    }

    // ---------- 偏好查询 ----------

    async _getPreferences({ category, include_details = true }) {
        try {
            const summaryParams = { user_id: 'feiniu_default' };
            if (category) summaryParams.category = category;
            const { data: summaryData } = await axios.get(`${this.apiUrl}/preferences/summary`, { params: summaryParams, timeout: 5000 });
            const summary = summaryData.summary || {};

            let preferences = [];
            if (include_details) {
                const listParams = { user_id: 'feiniu_default' };
                if (category) listParams.category = category;
                const { data: listData } = await axios.get(`${this.apiUrl}/preferences`, { params: listParams, timeout: 5000 });
                preferences = listData.preferences || [];
            }

            const totalCount = summary.total_count || 0;
            if (totalCount === 0) return 'No preferences of the user are recorded yet.';

            const result = [`User preferences: ${totalCount} preferences in ${summary.category_count || 0} categories`];

            const categories = summary.categories || {};
            if (Object.keys(categories).length > 0) {
                const catLabels = { food: 'Food', music: 'Music', game: 'Games', movie: 'Movies', hobby: 'Hobbies', style: 'Style', schedule: 'Schedule', general: 'General' };
                result.push('By category: ' + Object.entries(categories).map(([c, n]) => `${catLabels[c] || c}: ${n}`).join(', '));
            }

            if (include_details && preferences.length > 0) {
                result.push('\nDetails:');
                const likes = preferences.filter(p => (p.preference_type || p.type) === 'like');
                const dislikes = preferences.filter(p => (p.preference_type || p.type) === 'dislike');

                if (likes.length > 0) {
                    result.push('Likes:');
                    likes.slice(0, 10).forEach((p, i) => {
                        const conf = ((p.confidence || p.strength || 0.8) * 100).toFixed(0);
                        result.push(`  ${i + 1}. ${p.item || p.name || 'unknown'} [${p.category || 'general'}] (confidence: ${conf}%)`);
                    });
                    if (likes.length > 10) result.push(`  ... and ${likes.length - 10} more`);
                }
                if (dislikes.length > 0) {
                    result.push('Dislikes:');
                    dislikes.slice(0, 10).forEach((p, i) => {
                        const conf = ((p.confidence || p.strength || 0.8) * 100).toFixed(0);
                        result.push(`  ${i + 1}. ${p.item || p.name || 'unknown'} [${p.category || 'general'}] (confidence: ${conf}%)`);
                    });
                    if (dislikes.length > 10) result.push(`  ... and ${dislikes.length - 10} more`);
                }
            }

            return result.join('\n');
        } catch (error) {
            return this._connRefused(error) || `Error while getting preferences: ${error.message}`;
        }
    }
}

module.exports = { MemosTools };
