const { Plugin } = require('../../../js/core/plugin-base.js');
const axios = require('axios');

class RagMemoryPlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig();
        this._url = cfg.rag_url?.value || cfg.rag_url || 'http://127.0.0.1:8002/ask';
    }

    getTools() {
        return [{
            type: 'function',
            function: {
                name: 'search_memory',
                description: 'Search your memory system for related past conversations and information',
                parameters: {
                    type: 'object',
                    properties: {
                        question: { type: 'string', description: 'The question or keywords to search for' },
                        top_k: { type: 'integer', description: 'How many of the most relevant memories to return. Default: 1', default: 1 }
                    },
                    required: ['question']
                }
            }
        }];
    }

    async executeTool(name, params) {
        if (name === 'search_memory') return await this._searchMemory(params);
        throw new Error(`[rag-memory] Unsupported tool: ${name}`);
    }

    async _searchMemory({ question, top_k = 1 }) {
        const response = await axios.post(this._url, { question, top_k });
        return (response.data.relevant_passages || []).map(p => p.content).join('\n').trim();
    }
}

module.exports = RagMemoryPlugin;
