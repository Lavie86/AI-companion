const { Plugin } = require('../../../js/core/plugin-base.js');

const PATCH_ID_PASSIVE = 'watch-screen-passive';
const PATCH_ID_ACTIVE  = 'watch-screen-active';

class WatchScreenPlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig();

        this._captureInterval = cfg.captureInterval ?? 2000;
        this._maxFrames       = cfg.maxFrames   ?? 5;
        this._passiveMode     = cfg.passiveMode ?? true;
        this._activeMode      = cfg.activeMode  ?? true;

        this._frames       = [];
        this._captureTimer = null;
        this._isReacting   = false;
        this._ipc          = null;
    }

    async onStart() {
        try {
            this._ipc = require('electron').ipcRenderer;
        } catch (e) {
            this.context.log('error', 'Cannot load ipcRenderer');
            return;
        }

        if (this._passiveMode) {
            this.context.addSystemPromptPatch(PATCH_ID_PASSIVE,
                'When the user talks to you, their message comes with a screenshot of their current screen. You can use what is on the screen in your reply, as if you had been watching next to them the whole time.'
            );
        }

        if (this._activeMode) {
            this.context.addSystemPromptPatch(PATCH_ID_ACTIVE,
                'Sometimes you get a series of screenshots in a row. That is you watching the user\'s screen on your own. React naturally to what is on screen, as if you were really watching with them. If the screen is boring or just the desktop, you do not need to say anything.'
            );
        }

        await this._captureAndCheck().catch(() => {});
        this._captureTimer = setInterval(
            () => this._captureAndCheck().catch(() => {}),
            this._captureInterval
        );

        this.context.log('info', `Watch-screen plugin started | screenshot interval:${this._captureInterval}ms`);
    }

    async onStop() {
        this.context.removeSystemPromptPatch(PATCH_ID_PASSIVE);
        this.context.removeSystemPromptPatch(PATCH_ID_ACTIVE);
        if (this._captureTimer) { clearInterval(this._captureTimer); this._captureTimer = null; }
        this._frames = [];
    }

    async _captureAndCheck() {
        const base64 = await this._ipc.invoke('take-screenshot');
        this._frames.push({ base64, ts: Date.now() });

        if (this._frames.length < this._maxFrames) return;

        if (!this._activeMode || this._isReacting) {
            this._frames = [];
            return;
        }

        try {
            const { appState } = require('../../../js/core/app-state.js');
            if (appState.isPlayingTTS()) {
                this._frames = [];
                return;
            }
        } catch (_) {}

        const pictures = this._frames.slice();
        this._frames = [];

        // 清理上一轮消息里的图片，只保留文本
        const messages = this.context.getMessages();
        for (const msg of messages) {
            if (msg.role === 'user' && Array.isArray(msg.content)) {
                msg.content = msg.content.filter(p => p.type !== 'image_url');
            }
        }

        this._tryReact(pictures).catch(() => {});
    }

    async _tryReact(pictures) {
        this._isReacting = true;
        try {
            this.context.log('info', `Watching the screen, sending ${pictures.length} images to the AI`);
            await this.context.sendMessage([
                { type: 'text', text: '(screenshots)' },
                ...pictures.map(f => ({
                    type: 'image_url',
                    image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: 'low' }
                }))
            ]);
        } finally {
            this._isReacting = false;
        }
    }

    async onLLMRequest(request) {
        if (!this._passiveMode || this._frames.length === 0) return;

        const messages = request.messages;

        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role !== 'user') continue;
            if (Array.isArray(messages[i].content)) return;

            const text = messages[i].content ?? '';
            messages[i] = {
                ...messages[i],
                content: [
                    { type: 'text', text: String(text) },
                    ...this._frames.map(f => ({
                        type: 'image_url',
                        image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: 'low' }
                    }))
                ]
            };
            return;
        }
    }
}

module.exports = WatchScreenPlugin;
