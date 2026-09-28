const { Plugin } = require('../../../js/core/plugin-base.js');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const PYTHON_SCRIPT = `# -*- coding: utf-8 -*-
import sys, json, time
try:
    import pyperclip, pyautogui
except ImportError as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)

text = sys.argv[1] if len(sys.argv) > 1 else ''
submit = sys.argv[2].lower() == 'true' if len(sys.argv) > 2 else False

pyperclip.copy(text)
time.sleep(0.2)
pyautogui.hotkey('ctrl', 'v')
if submit:
    time.sleep(0.5)
    pyautogui.press('enter')
    result = f"Typed {len(text)} characters, then pressed Enter to submit"
else:
    result = f"Typed {len(text)} characters"

print(json.dumps({"result": result}, ensure_ascii=False))
`;

class TypingPlugin extends Plugin {

    getTools() {
        return [{
            type: 'function',
            function: {
                name: 'type_text',
                description: 'Type text where the keyboard focus is, like real typing',
                parameters: {
                    type: 'object',
                    properties: {
                        text: { type: 'string', description: 'The text to type' },
                        submit: { type: 'boolean', description: 'Whether to press Enter after typing, to submit it' }
                    },
                    required: ['text']
                }
            }
        }];
    }

    async executeTool(name, params) {
        if (name === 'type_text') return await this._typeText(params);
        throw new Error(`[typing] Unsupported tool: ${name}`);
    }

    async _typeText({ text, submit = false }) {
        if (!text) throw new Error('The text parameter is missing');

        return new Promise((resolve, reject) => {
            const tempScriptPath = path.join(__dirname, 'temp_typing.py');
            fs.writeFileSync(tempScriptPath, PYTHON_SCRIPT);

            const escapedText = JSON.stringify(text);
            const isWindows = process.platform === 'win32';
            const command = isWindows
                ? `call conda activate my-neuro && python "${tempScriptPath}" ${escapedText} ${submit}`
                : `source activate my-neuro && python "${tempScriptPath}" ${escapedText} ${submit}`;

            exec(command, { timeout: 10000, shell: isWindows ? 'cmd.exe' : '/bin/bash', env: { ...process.env, CONDA_DLL_SEARCH_MODIFICATION_ENABLE: '1' } }, (error, stdout) => {
                try { fs.unlinkSync(tempScriptPath); } catch (e) {}
                if (error) return reject(new Error(`Failed to run: ${error.message}`));
                try {
                    const result = JSON.parse(stdout);
                    result.error ? reject(new Error(result.error)) : resolve(result.result);
                } catch { resolve(stdout || 'Finished typing'); }
            });
        });
    }
}

module.exports = TypingPlugin;
