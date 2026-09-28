"""
备忘录插件
AI 可以用工具帮用户记录、查看、删除备忘，数据持久化到 JSON 文件。
"""

import json
import os
from datetime import datetime
from plugin_sdk import Plugin, run


class NotesPlugin(Plugin):

    # ===== 文件读写 =====

    def _notes_path(self):
        cfg = self.context.get_plugin_config()
        return cfg.get('file', '../AI记录室/备忘录.json')

    def _load(self):
        path = self._notes_path()
        if not os.path.exists(path):
            return []
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return []

    def _save(self, notes):
        path = self._notes_path()
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(notes, f, ensure_ascii=False, indent=2)

    # ===== 生命周期 =====

    async def on_start(self):
        notes = self._load()
        self.context.storage.set('notes', notes)
        self.context.log('info', f'Notes loaded: {len(notes)} in total')

    async def on_stop(self):
        notes = self.context.storage.get('notes') or []
        self._save(notes)

    # ===== 工具注册 =====

    def get_tools(self):
        return [
            {
                'type': 'function',
                'function': {
                    'name': 'save_note',
                    'description': 'Save a note for the user. Use it when the user says "note this down", "help me remember", "do not forget" and so on',
                    'parameters': {
                        'type': 'object',
                        'properties': {
                            'content': {
                                'type': 'string',
                                'description': 'What to note down'
                            }
                        },
                        'required': ['content']
                    }
                }
            },
            {
                'type': 'function',
                'function': {
                    'name': 'list_notes',
                    'description': 'Show the notes the user saved. Use it when the user asks "what did I note down", "do I have any notes" and so on',
                    'parameters': {
                        'type': 'object',
                        'properties': {
                            'limit': {
                                'type': 'integer',
                                'description': 'The most notes to show. Shows all of them by default'
                            }
                        },
                        'required': []
                    }
                }
            },
            {
                'type': 'function',
                'function': {
                    'name': 'delete_note',
                    'description': 'Delete the note with the given number',
                    'parameters': {
                        'type': 'object',
                        'properties': {
                            'index': {
                                'type': 'integer',
                                'description': 'Note number (starts at 1, get it from list_notes)'
                            }
                        },
                        'required': ['index']
                    }
                }
            },
            {
                'type': 'function',
                'function': {
                    'name': 'clear_notes',
                    'description': 'Delete all notes',
                    'parameters': {
                        'type': 'object',
                        'properties': {},
                        'required': []
                    }
                }
            }
        ]

    # ===== 工具执行 =====

    async def execute_tool(self, name, params):
        notes = self.context.storage.get('notes') or []

        if name == 'save_note':
            content = params.get('content', '').strip()
            if not content:
                return 'The note must not be empty.'
            note = {
                'content': content,
                'time': datetime.now().strftime('%Y-%m-%d %H:%M')
            }
            notes.append(note)
            self.context.storage.set('notes', notes)
            self._save(notes)
            return f'Saved note #{len(notes)}: {content}'

        elif name == 'list_notes':
            if not notes:
                return 'There are no notes yet.'
            limit = params.get('limit', len(notes))
            shown = notes[-limit:]
            offset = len(notes) - len(shown)
            lines = [f'{len(notes)} notes:']
            for i, note in enumerate(shown, start=offset + 1):
                lines.append(f'{i}. [{note["time"]}] {note["content"]}')
            return '\n'.join(lines)

        elif name == 'delete_note':
            idx = params.get('index', 0) - 1
            if idx < 0 or idx >= len(notes):
                return f'Invalid number. There are {len(notes)} notes.'
            removed = notes.pop(idx)
            self.context.storage.set('notes', notes)
            self._save(notes)
            return f'Deleted: {removed["content"]}'

        elif name == 'clear_notes':
            count = len(notes)
            self.context.storage.set('notes', [])
            self._save([])
            return f'Deleted all {count} notes.'

        return 'Unknown tool.'


if __name__ == '__main__':
    run(NotesPlugin)
