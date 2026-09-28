const { Plugin } = require('../../../js/core/plugin-base.js');

class WaitPlugin extends Plugin {

    getTools() {
        return [{
            type: 'function',
            function: {
                name: 'wait',
                description: 'Wait for a given time, for example while a page loads or a video plays',
                parameters: {
                    type: 'object',
                    properties: {
                        time: { type: 'number', description: 'How long to wait, in seconds (at most 10)' }
                    },
                    required: ['time']
                }
            }
        }];
    }

    async executeTool(name, params) {
        if (name === 'wait') return await this._wait(params);
        throw new Error(`[wait] Unsupported tool: ${name}`);
    }

    async _wait({ time }) {
        if (!time || time <= 0) throw new Error('The wait time must be more than 0');
        if (time > 10) time = 10;
        return new Promise(resolve => setTimeout(() => resolve(`✅ Waited ${time} seconds`), time * 1000));
    }
}

module.exports = WaitPlugin;
