const { Plugin } = require('../../../js/core/plugin-base.js');
const fs = require('fs');
const path = require('path');

class NotePlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig();
        const fileName = cfg.memory_file?.value || cfg.memory_file || '用户记忆.json';
        this._memoryFile = path.join(process.cwd(), fileName);
    }

    getTools() {
        return [
            { type: 'function', function: { name: 'record_memory', description: 'Record core memories about the user, such as personal information (age, experiences, preferences) and plans', parameters: { type: 'object', properties: { content: { type: 'string', description: 'What to record' } }, required: ['content'] } } },
            { type: 'function', function: { name: 'read_memory', description: 'Read the recorded memories about the user, shown as a list with IDs', parameters: { type: 'object', properties: { count: { type: 'number', description: 'Read the latest N records. Leave it out or pass 0 to read all of them' } }, required: [] } } },
            { type: 'function', function: { name: 'delete_memory', description: 'Delete the record with the given ID', parameters: { type: 'object', properties: { id: { type: 'number', description: 'Which record to delete, by ID' } }, required: ['id'] } } },
            { type: 'function', function: { name: 'search_memory', description: 'Search the memory records for a keyword', parameters: { type: 'object', properties: { keyword: { type: 'string', description: 'Search keyword' } }, required: ['keyword'] } } }
        ];
    }

    async executeTool(name, params) {
        switch (name) {
            case 'record_memory': return await this._recordMemory(params);
            case 'read_memory':   return await this._readMemory(params);
            case 'delete_memory': return await this._deleteMemory(params);
            case 'search_memory': return await this._searchMemory(params);
            default: throw new Error(`[note] Unsupported tool: ${name}`);
        }
    }

    _load() {
        try {
            if (!fs.existsSync(this._memoryFile)) return [];
            const content = fs.readFileSync(this._memoryFile, 'utf8');
            return content.trim() ? JSON.parse(content) : [];
        } catch { return []; }
    }

    _save(memories) {
        fs.writeFileSync(this._memoryFile, JSON.stringify(memories, null, 2), 'utf8');
    }

    _date() {
        const d = new Date();
        return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    }

    async _recordMemory({ content }) {
        if (!content?.trim()) return '⚠️ The content to record must not be empty';
        const memories = this._load();
        const newId = memories.length > 0 ? Math.max(...memories.map(m => m.id)) + 1 : 1;
        memories.push({ id: newId, date: this._date(), content });
        this._save(memories);
        return `✅ Recorded (ID: ${newId})`;
    }

    async _readMemory({ count = 0 }) {
        const memories = this._load();
        if (memories.length === 0) return '⚠️ There are no records yet';
        const result = count > 0 && count < memories.length ? memories.slice(-count) : memories;
        return `📝 Memories about the user (${memories.length} in total):\n\n${result.map(m => `${m.id}. [${m.date}] ${m.content}`).join('\n\n')}`;
    }

    async _deleteMemory({ id }) {
        const memories = this._load();
        const index = memories.findIndex(m => m.id === id);
        if (index === -1) return `⚠️ No record with ID ${id} exists`;
        const deleted = memories.splice(index, 1)[0];
        this._save(memories);
        return `✅ Deleted the record (ID: ${id}):\n[${deleted.date}] ${deleted.content}`;
    }

    async _searchMemory({ keyword }) {
        if (!keyword?.trim()) return '⚠️ The keyword must not be empty';
        const memories = this._load();
        const results = memories.filter(m => m.content.includes(keyword) || m.date.includes(keyword));
        if (results.length === 0) return `⚠️ No records found with "${keyword}" in them`;
        return `🔍 Search results (${results.length} found):\n\n${results.map(m => `${m.id}. [${m.date}] ${m.content}`).join('\n\n')}`;
    }
}

module.exports = NotePlugin;
