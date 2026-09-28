const { Plugin } = require('../../../js/core/plugin-base.js');
const { exec } = require('child_process');

class WebNavigatorPlugin extends Plugin {

    getTools() {
        return [{
            type: 'function',
            function: {
                name: 'open_webpage',
                description: 'Open a web address in the default browser',
                parameters: {
                    type: 'object',
                    properties: {
                        url: { type: 'string', description: 'The web address to open' }
                    },
                    required: ['url']
                }
            }
        }];
    }

    async executeTool(name, params) {
        if (name === 'open_webpage') return await this._openWebpage(params);
        throw new Error(`[web-navigator] Unsupported tool: ${name}`);
    }

    async _openWebpage({ url }) {
        if (!url || url.trim() === '') throw new Error('The web address must not be empty');
        if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;

        return new Promise((resolve, reject) => {
            const isWindows = process.platform === 'win32';
            const isMac = process.platform === 'darwin';
            const command = isWindows ? `start "" "${url}"` : isMac ? `open "${url}"` : `xdg-open "${url}"`;

            exec(command, { timeout: 5000, shell: isWindows ? 'cmd.exe' : '/bin/bash' }, (error) => {
                if (error) reject(new Error(`Failed to open the web page: ${error.message}`));
                else resolve(`✅ Opened in the browser: ${url}`);
            });
        });
    }
}

module.exports = WebNavigatorPlugin;
