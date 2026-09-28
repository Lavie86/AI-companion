// plugins/community/smart-barrage/index.js
//
// 工作方式：
//   - 滑动窗口：每 windowSeconds 秒把收集到的弹幕交给 LLM 过滤一次
//   - LLM 从这批弹幕里挑出最多 maxRespond 条值得回复的，合并成一条消息让 AI 回应
//   - 带 prefixChar（默认 #）前缀的弹幕跳过过滤，立即单独响应
//
// 模式（mode）：
//   smart  — 所有弹幕走 LLM 过滤
//   prefix — 只响应带 # 前缀的弹幕
//   both   — # 前缀立即响应，其余走 LLM 过滤（默认）

const { Plugin } = require('../../../js/core/plugin-base.js');
const { LiveStreamModule } = require('../../../js/live/LiveStreamModule.js');

const SYSTEM_PATCH_ID = 'smart-barrage-context';

class SmartBarragePlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig();

        this._roomId        = cfg.roomId        ?? 30230160;
        this._mode          = cfg.mode          ?? 'both';
        this._windowMs      = (cfg.windowSeconds ?? 15) * 1000;
        this._maxRespond    = cfg.maxRespond    ?? 3;
        this._maxBuffer     = cfg.maxBufferSize  ?? 30;
        this._prefixChar    = cfg.prefixChar    ?? '#';
        this._checkInterval = cfg.checkInterval  ?? 5000;

        this._buffer      = [];   // 当前窗口内收集的普通弹幕
        this._windowTimer = null;
        this._liveModule  = null;
    }

    async onStart() {
        // 注入系统提示词，让 AI 知道自己在直播
        this.context.addSystemPromptPatch(SYSTEM_PATCH_ID,
            'You are live streaming on Bilibili right now. You may receive chat messages from viewers, ' +
            'marked with [Live chat message]. Interact with the viewers naturally, like a real streamer. ' +
            'Messages marked with [Live chat question] are questions a viewer asked you directly. Answer those first.'
        );

        this._liveModule = new LiveStreamModule({
            roomId:        this._roomId,
            checkInterval: this._checkInterval,
            onNewMessage:  (msg) => this._onBarrage(msg)
        });

        this._liveModule.start();
        this.context.log('info', `Smart live chat started | room:${this._roomId} | mode:${this._mode} | window:${this._windowMs / 1000}s`);
    }

    async onStop() {
        this.context.removeSystemPromptPatch(SYSTEM_PATCH_ID);

        if (this._liveModule) {
            this._liveModule.stop();
            this._liveModule = null;
        }
        if (this._windowTimer) {
            clearTimeout(this._windowTimer);
            this._windowTimer = null;
        }
        this._buffer = [];
    }

    // ===== 弹幕入口 =====

    _onBarrage({ nickname, text }) {
        const hasPrefix = text.startsWith(this._prefixChar);

        // # 前缀弹幕：跳过过滤，立即响应
        if (hasPrefix && (this._mode === 'prefix' || this._mode === 'both')) {
            const clean = text.slice(this._prefixChar.length).trim();
            if (!clean) return;
            this.context.log('info', `[Question] ${nickname}: ${clean}`);
            this.context.sendMessage(
                `[Live chat question] ${nickname} asks you: ${clean}`
            ).catch(e => this.context.log('error', `sendMessage failed: ${e.message}`));
            return;
        }

        // prefix-only 模式：其余弹幕直接忽略
        if (this._mode === 'prefix') return;

        // smart / both 模式：加入窗口缓冲
        this._buffer.push({ nickname, text });

        // 超出上限时丢最旧的
        if (this._buffer.length > this._maxBuffer) {
            this._buffer.shift();
        }

        // 第一条进来时启动窗口计时器
        if (!this._windowTimer) {
            this._windowTimer = setTimeout(() => this._flushWindow(), this._windowMs);
        }
    }

    // ===== 窗口到期，过滤并回复 =====

    async _flushWindow() {
        this._windowTimer = null;
        if (this._buffer.length === 0) return;

        const batch = this._buffer.slice();
        this._buffer = [];

        this.context.log('info', `Filtering a batch of ${batch.length} live chat messages`);

        try {
            const selected = await this._filterWithLLM(batch);

            if (selected.length === 0) {
                this.context.log('info', 'Nothing in this batch is worth a reply, skipping');
                return;
            }

            const prompt = this._buildPrompt(selected);
            this.context.log('info', `Picked ${selected.length} messages, replying`);
            await this.context.sendMessage(prompt);

        } catch (e) {
            this.context.log('error', `Failed to process the live chat batch: ${e.message}`);
        }
    }

    // ===== LLM 过滤 =====

    async _filterWithLLM(batch) {
        const numbered = batch.map((m, i) => `${i + 1}. ${m.nickname}: ${m.text}`).join('\n');

        const prompt =
            `You help an AI live streamer by picking the chat messages worth replying to.\n` +
            `Below are the chat messages from the last ${this._windowMs / 1000} seconds of the stream. Pick at most ${this._maxRespond} that are most worth a reply.\n` +
            `Prefer: real questions, fun comments, topics worth talking about.\n` +
            `Ignore: spam, meaningless "hahaha", emoji only, repeated questions.\n` +
            `If nothing in the batch is worth a reply, return an empty array.\n` +
            `Return only the numbers you picked, as a JSON array such as [1,3] or [], and no other text.\n\n` +
            `Chat messages:\n${numbered}`;

        try {
            const raw = await this.context.callLLM(prompt, { temperature: 0.2 });
            const match = raw.match(/\[[\d,\s]*\]/);
            if (!match) return [];

            const indices = JSON.parse(match[0]);
            return indices
                .filter(i => Number.isInteger(i) && i >= 1 && i <= batch.length)
                .slice(0, this._maxRespond)
                .map(i => batch[i - 1]);

        } catch (e) {
            this.context.log('warn', `LLM filter call failed: ${e.message}`);
            return [];
        }
    }

    // ===== 构建发给 AI 的消息 =====

    _buildPrompt(selected) {
        if (selected.length === 1) {
            return `[Live chat message] ${selected[0].nickname} says: ${selected[0].text}`;
        }
        const lines = selected.map(m => `- ${m.nickname}: ${m.text}`).join('\n');
        return `[Live chat message] Viewers say:\n${lines}`;
    }
}

module.exports = SmartBarragePlugin;
