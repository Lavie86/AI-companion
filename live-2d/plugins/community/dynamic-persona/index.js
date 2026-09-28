const { Plugin } = require('../../../js/core/plugin-base.js');

class DynamicPersonaPlugin extends Plugin {

    async onInit() {
        this.persona = '';
        this.msgCount = 0;
        const cfg = this.context.getPluginConfig();
        this.updateFreq = cfg.update_frequency ?? 3; // 每N条消息更新一次
    }

    async onLLMRequest(request) {
        this.msgCount++;

        // 按频率更新人格
        if (this.msgCount % this.updateFreq !== 0 && this.persona) return;

        // 找最后一条用户消息
        const userMsg = [...request.messages].reverse().find(m => m.role === 'user');
        const userText = typeof userMsg?.content === 'string'
            ? userMsg.content
            : userMsg?.content?.[0]?.text || '';

        const hour = new Date().getHours();
        const timeStr = hour < 6 ? 'late at night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : hour < 22 ? 'evening' : 'late at night';

        try {
            this.persona = await this.context.callLLM(
                `It is ${timeStr}, and the user said: "${userText}".\n` +
                `In 10 words or fewer, describe the character's state or mood right now. It sets the tone of her next reply. ` +
                `Output only the state itself, no explanation. For example: "a bit sleepy but hanging in there" or "suddenly curious about this topic"`,
                { temperature: 1.2 }
            );
            this.context.log('info', `Dynamic persona updated: ${this.persona}`);
        } catch (e) {
            return;
        }

        // 注入到系统消息
        const sysMsg = request.messages.find(m => m.role === 'system');
        if (sysMsg && this.persona) {
            sysMsg.content += `\n\n(Your current state: ${this.persona})`;
        }
    }
}

module.exports = DynamicPersonaPlugin;
