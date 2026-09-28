const { Plugin } = require('../../../js/core/plugin-base.js');
const { ipcRenderer } = require('electron');

class ScreenshotPlugin extends Plugin {

    getTools() {
        return [{
            type: 'function',
            function: {
                name: 'take_screenshot',
                description: 'Take a screenshot of the screen and return the image, so you can see what is on the computer screen',
                parameters: { type: 'object', properties: {}, required: [] }
            }
        }];
    }

    async executeTool(name, params) {
        if (name === 'take_screenshot') return await this._takeScreenshot();
        throw new Error(`[screenshot] Unsupported tool: ${name}`);
    }

    async _takeScreenshot() {
        try {
            const base64Image = await ipcRenderer.invoke('take-screenshot');
            if (!base64Image) throw new Error('The screenshot returned no data');
            return { _isScreenshot: true, base64: base64Image, message: 'Screenshot taken' };
        } catch (error) {
            return `Screenshot failed: ${error.message}`;
        }
    }
}

module.exports = ScreenshotPlugin;
