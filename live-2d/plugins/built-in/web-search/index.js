const { Plugin } = require('../../../js/core/plugin-base.js');
const axios = require('axios');

const TOOL_DEFINITION = {
    type: 'function',
    function: {
        name: 'web_search',
        description: 'Search the web with a search engine and return the results',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Keywords of what to search for'
                }
            },
            required: ['query']
        }
    }
};

class WebSearchPlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig();
        this._tavilyKey = cfg.tavily_api_key?.value || cfg.tavily_api_key || '';
    }

    getTools() {
        if (!this._tavilyKey) return [];
        return [TOOL_DEFINITION];
    }

    async executeTool(name, params) {
        if (name === 'web_search') return await this._webSearch(params);
        throw new Error(`[web-search] Unsupported tool: ${name}`);
    }

    async _webSearch({ query }) {
        try {
            this.context.log('info', `[web-search] Searching: ${query}`);

            const response = await axios.post('https://api.tavily.com/search', {
                query,
                max_results: 3,
                include_answer: true,
                search_depth: 'basic',
                api_key: this._tavilyKey
            });

            if (!response.data) return 'Error: the search returned no results';

            let fullContent = '';

            const aiAnswer = response.data.answer || 'no AI summary';
            fullContent += `AI answer summary: ${aiAnswer}\n\n`;

            const searchResults = response.data.results || [];
            if (searchResults.length > 0) {
                fullContent += 'Detailed search results:\n';
                searchResults.forEach((result, i) => {
                    const title = result.title || 'no title';
                    const content = result.content || 'no content';
                    const url = result.url || 'no URL';
                    fullContent += `${i + 1}. Title: ${title}\n`;
                    fullContent += `   Content: ${content.substring(0, 1500)}...\n`;
                    fullContent += `   Source: ${url}\n\n`;
                });
            } else {
                fullContent += 'No matching search results found.\n';
            }

            return fullContent;

        } catch (error) {
            this.context.log('error', `[web-search] Search error: ${error.message}`);
            if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
                return 'Error: the network connection failed. Check your connection';
            }
            return `Error during the search: ${error.message}`;
        }
    }
}

module.exports = WebSearchPlugin;
