const { Plugin } = require('../../../js/core/plugin-base.js');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// The script never changes. The API settings and the LLM's element description reach it
// through environment variables. Pasting them into the source let a crafted description
// (for example from text on the screen or a web page) run any Python code.
const PC_CLICK_SCRIPT = `# -*- coding: utf-8 -*-
import json, base64, io, os, sys
try:
    import pyautogui
    from openai import OpenAI
    from PIL import ImageGrab, ImageDraw
except ImportError as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)

api_key = os.environ.get('MYNEURO_PC_API_KEY', '')
api_url = os.environ.get('MYNEURO_PC_API_URL', '')
model = os.environ.get('MYNEURO_PC_MODEL', '')
target = os.environ.get('MYNEURO_PC_TARGET', '')
client = OpenAI(api_key=api_key, base_url=api_url)

scr = ImageGrab.grab()
buf = io.BytesIO()
scr.save(buf, format='JPEG')
image_data = base64.b64encode(buf.getvalue()).decode('utf-8')

messages = [
    {'role': 'system', 'content': 'You are a vision assistant for PC screens. Find the element the user describes in the screenshot and return it as JSON {"bbox_2d": [x1, y1, x2, y2]}. Output nothing else.'},
    {'role': 'user', 'content': [{'type': 'image_url', 'image_url': {'url': f'data:image/jpeg;base64,{image_data}'}}, {'type': 'text', 'text': target}]}
]

try:
    response = client.chat.completions.create(model=model, messages=messages, stream=True)
    content = ''.join(c.choices[0].delta.content or '' for c in response if c.choices)
    bbox = json.loads(content)['bbox_2d']
    cx, cy = (bbox[0]+bbox[2])//2, (bbox[1]+bbox[3])//2
    pyautogui.moveTo(cx, cy, duration=0.25)
    pyautogui.doubleClick()
    print(json.dumps({"result": f"Clicked: {target}"}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"result": f"Click failed: {str(e)}"}, ensure_ascii=False))
`;

class PcControlPlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig();
        this._apiKey = cfg.api_key?.value || cfg.api_key || '';
        this._apiUrl = cfg.api_url?.value || cfg.api_url || 'https://api.siliconflow.cn/v1';
        this._model  = cfg.model?.value   || cfg.model   || 'Qwen/Qwen2.5-VL-72B-Instruct';
    }

    getTools() {
        if (!this._apiKey) return [];
        return [{
            type: 'function',
            function: {
                name: 'pc_screen_click',
                description: 'Click a screen element, found with a screenshot and AI vision',
                parameters: {
                    type: 'object',
                    properties: {
                        element_description: { type: 'string', description: "Description of the screen element to click, for example 'the OK button', 'the search box'" }
                    },
                    required: ['element_description']
                }
            }
        }];
    }

    async executeTool(name, params) {
        if (name === 'pc_screen_click') return await this._pcScreenClick(params);
        throw new Error(`[pc-control] Unsupported tool: ${name}`);
    }

    async _pcScreenClick({ element_description }) {
        if (!element_description) throw new Error('The element_description parameter is missing');

        return new Promise((resolve, reject) => {
            const tempScriptPath = path.join(__dirname, 'temp_pc_control.py');
            fs.writeFileSync(tempScriptPath, PC_CLICK_SCRIPT);

            const isWindows = process.platform === 'win32';
            const command = isWindows
                ? `call conda activate my-neuro && python "${tempScriptPath}"`
                : `source activate my-neuro && python "${tempScriptPath}"`;

            exec(command, { timeout: 30000, shell: isWindows ? 'cmd.exe' : '/bin/bash', env: {
                ...process.env,
                CONDA_DLL_SEARCH_MODIFICATION_ENABLE: '1',
                MYNEURO_PC_API_KEY: String(this._apiKey),
                MYNEURO_PC_API_URL: String(this._apiUrl),
                MYNEURO_PC_MODEL: String(this._model),
                MYNEURO_PC_TARGET: String(element_description)
            } }, (error, stdout) => {
                try { fs.unlinkSync(tempScriptPath); } catch (e) {}
                if (error) return reject(new Error(`Failed to run: ${error.message}`));
                try {
                    const result = JSON.parse(stdout);
                    resolve(result.result || result.error);
                } catch { resolve(stdout || 'Done'); }
            });
        });
    }
}

module.exports = PcControlPlugin;
