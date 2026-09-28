const { Plugin } = require('../../../js/core/plugin-base.js');
const fs = require('fs');
const path = require('path');

class SchedulePlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig();
        const fileName = cfg.schedule_file?.value || cfg.schedule_file || '日程表.json';
        this._scheduleFile = path.join(process.cwd(), fileName);
        const dir = path.dirname(this._scheduleFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    getTools() {
        return [
            {
                type: 'function',
                function: {
                    name: 'add_schedule',
                    description: 'Add a schedule item. When the user tells you what they need to do and when, write it down with this tool. Fill in time when you can. If there is no set time, use "TBD".',
                    parameters: {
                        type: 'object',
                        properties: {
                            title: { type: 'string', description: 'Title: a short description of what to do' },
                            time:  { type: 'string', description: 'The time, for example "tomorrow at 3 pm", "2026-04-05 14:00", "TBD" or similar' },
                            note:  { type: 'string', description: 'Note (optional): extra details' }
                        },
                        required: ['title', 'time']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'list_schedule',
                    description: 'Show the schedule. You can filter to see only the open items, or all of them.',
                    parameters: {
                        type: 'object',
                        properties: {
                            filter: {
                                type: 'string',
                                enum: ['all', 'pending', 'done'],
                                description: 'Filter: all=everything, pending=not done yet, done=done. Default: pending.'
                            }
                        },
                        required: []
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'complete_schedule',
                    description: 'Mark the schedule item with the given ID as done. Use it when the user says things like "I finished it", "done".',
                    parameters: {
                        type: 'object',
                        properties: {
                            id: { type: 'number', description: 'The schedule item to mark as done, by ID' }
                        },
                        required: ['id']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'delete_schedule',
                    description: 'Delete the schedule item with the given ID. It is removed completely, with no record kept.',
                    parameters: {
                        type: 'object',
                        properties: {
                            id: { type: 'number', description: 'The schedule item to delete, by ID' }
                        },
                        required: ['id']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'search_schedule',
                    description: 'Search the schedule by keyword.',
                    parameters: {
                        type: 'object',
                        properties: {
                            keyword: { type: 'string', description: 'Search keyword' }
                        },
                        required: ['keyword']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'edit_schedule',
                    description: 'Change the title, time or note of the schedule item with the given ID. Only pass the fields you want to change.',
                    parameters: {
                        type: 'object',
                        properties: {
                            id:    { type: 'number', description: 'The schedule item to change, by ID' },
                            title: { type: 'string', description: 'New title (optional)' },
                            time:  { type: 'string', description: 'New time (optional)' },
                            note:  { type: 'string', description: 'New note (optional)' }
                        },
                        required: ['id']
                    }
                }
            }
        ];
    }

    async executeTool(name, params) {
        switch (name) {
            case 'add_schedule':      return await this._add(params);
            case 'list_schedule':     return await this._list(params);
            case 'complete_schedule': return await this._complete(params);
            case 'delete_schedule':   return await this._delete(params);
            case 'search_schedule':   return await this._search(params);
            case 'edit_schedule':     return await this._edit(params);
            default: throw new Error(`[schedule] Unsupported tool: ${name}`);
        }
    }

    _load() {
        try {
            if (!fs.existsSync(this._scheduleFile)) return [];
            const content = fs.readFileSync(this._scheduleFile, 'utf8');
            return content.trim() ? JSON.parse(content) : [];
        } catch { return []; }
    }

    _save(list) {
        fs.writeFileSync(this._scheduleFile, JSON.stringify(list, null, 2), 'utf8');
    }

    _today() {
        const d = new Date();
        return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    }

    _nextId(list) {
        return list.length > 0 ? Math.max(...list.map(s => s.id)) + 1 : 1;
    }

    _fmt(item) {
        const status = item.done ? '✅' : '⏳';
        const note = item.note ? `  Note: ${item.note}` : '';
        return `${status} [ID:${item.id}] ${item.title}  🕐 ${item.time}${note}`;
    }

    async _add({ title, time, note }) {
        if (!title?.trim()) return '⚠️ The schedule title must not be empty';
        const list = this._load();
        const item = {
            id: this._nextId(list),
            title: title.trim(),
            time: time?.trim() || 'TBD',
            note: note?.trim() || '',
            done: false,
            created_at: this._today()
        };
        list.push(item);
        this._save(list);
        return `✅ Schedule item saved (ID: ${item.id})\n${this._fmt(item)}`;
    }

    async _list({ filter = 'pending' } = {}) {
        const list = this._load();
        if (list.length === 0) return '⚠️ The schedule is empty';

        let filtered;
        if (filter === 'done')    filtered = list.filter(s => s.done);
        else if (filter === 'all') filtered = list;
        else                       filtered = list.filter(s => !s.done);

        if (filtered.length === 0) {
            const label = filter === 'done' ? 'done' : 'open';
            return `⚠️ No ${label} schedule items`;
        }

        const label = filter === 'done' ? 'done' : filter === 'all' ? 'all' : 'open';
        return `📅 Schedule (${label}, ${filtered.length} items):\n\n${filtered.map(s => this._fmt(s)).join('\n')}`;
    }

    async _complete({ id }) {
        const list = this._load();
        const item = list.find(s => s.id === id);
        if (!item) return `⚠️ No schedule item with ID ${id} exists`;
        if (item.done) return `⚠️ ID ${id} is already done`;
        item.done = true;
        item.done_at = this._today();
        this._save(list);
        return `✅ Done: ${item.title} (ID: ${id})`;
    }

    async _delete({ id }) {
        const list = this._load();
        const index = list.findIndex(s => s.id === id);
        if (index === -1) return `⚠️ No schedule item with ID ${id} exists`;
        const deleted = list.splice(index, 1)[0];
        this._save(list);
        return `🗑️ Deleted: ${deleted.title} (ID: ${id})`;
    }

    async _search({ keyword }) {
        if (!keyword?.trim()) return '⚠️ The keyword must not be empty';
        const list = this._load();
        const results = list.filter(s =>
            s.title.includes(keyword) ||
            s.time.includes(keyword) ||
            (s.note && s.note.includes(keyword))
        );
        if (results.length === 0) return `⚠️ No schedule items contain "${keyword}"`;
        return `🔍 Search results (${results.length} found):\n\n${results.map(s => this._fmt(s)).join('\n')}`;
    }

    async _edit({ id, title, time, note }) {
        const list = this._load();
        const item = list.find(s => s.id === id);
        if (!item) return `⚠️ No schedule item with ID ${id} exists`;
        if (title !== undefined) item.title = title.trim();
        if (time  !== undefined) item.time  = time.trim();
        if (note  !== undefined) item.note  = note.trim();
        this._save(list);
        return `✏️ Updated (ID: ${id})\n${this._fmt(item)}`;
    }
}

module.exports = SchedulePlugin;
