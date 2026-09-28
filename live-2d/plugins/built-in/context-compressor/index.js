const { Plugin } = require('../../../js/core/plugin-base.js');

// The summary message starts with this marker. The Chinese one is from before the
// translation and is still recognised in saved conversations.
const SUMMARY_MARKERS = ['[Conversation summary]', '[历史对话总结]'];
const SUMMARY_PREFIX = /^\[(?:Conversation summary|历史对话总结)\] /;

class ContextCompressorPlugin extends Plugin {

    async onInit() {
        this._compressing = false;
    }

    async onLLMResponse(response) {
        const cfg = this.context.getPluginFileConfig();
        if (this._compressing) return;

        const voiceChat = global.voiceChat;
        if (!voiceChat?.messages) return;

        const threshold = cfg.trigger_threshold || 15;
        if (voiceChat.messages.length < threshold) return;

        this._compress(voiceChat, cfg).catch(e => {
            this.context.log('warn', `Context compression failed: ${e.message}`);
        });
    }

    async _compress(voiceChat, cfg) {
        this._compressing = true;
        try {
            const keepRecent = cfg.keep_recent || 4;
            const prompt = cfg.prompt || 'Summarize the conversation below as short key points. Keep the important information and context.';
            const messages = voiceChat.messages;
            const total = messages.length;

            const systemMsgs = messages.filter(m => m.role === 'system');
            const nonSystem = messages.filter(m => m.role !== 'system');

            const isSummary = m => SUMMARY_MARKERS.some(marker => m.content.includes(marker));
            const initialSystem = systemMsgs.filter(m => !isSummary(m));
            const prevSummaryMsg = systemMsgs.find(isSummary);

            const recent = nonSystem.slice(-keepRecent * 2);
            const old = nonSystem.slice(0, -keepRecent * 2);
            if (old.length === 0) return;

            const convText = old.map(m =>
                m.role === 'user' ? `User: ${this._text(m.content)}`
                : m.role === 'assistant' ? `AI: ${this._text(m.content)}`
                : ''
            ).filter(Boolean).join('\n');

            const prevSummary = prevSummaryMsg
                ? prevSummaryMsg.content.replace(SUMMARY_PREFIX, '')
                : null;

            const compressPrompt = prevSummary
                ? `${prompt}\n\n[Previous summary]:\n${prevSummary}\n\n[New conversation]:\n${convText}\n\nMerge them into one complete summary:`
                : `${prompt}\n\nConversation:\n${convText}\n\nSummary:`;

            const summary = await this.context.callLLM(compressPrompt, { max_tokens: 500, stream: false });
            if (!summary?.trim()) return;

            voiceChat.messages.length = 0;
            voiceChat.messages.push(
                ...initialSystem,
                { role: 'system', content: `${SUMMARY_MARKERS[0]} ${summary.trim()}` },
                ...recent
            );

            this.context.log('info', `Context compressed: ${total} messages → ${voiceChat.messages.length} messages`);
        } finally {
            this._compressing = false;
        }
    }

    _text(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) return content.filter(p => p.type === 'text').map(p => p.text).join(' ');
        return '';
    }
}

module.exports = ContextCompressorPlugin;
