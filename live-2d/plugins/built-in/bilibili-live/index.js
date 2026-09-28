// plugins/built-in/bilibili-live/index.js
const { Plugin } = require('../../../js/core/plugin-base.js');
const { LiveStreamModule } = require('../../../js/live/LiveStreamModule.js');
const { logToTerminal } = require('../../../js/api-utils.js');

class BilibiliLivePlugin extends Plugin {
    constructor(metadata, context) {
        super(metadata, context);
        this._liveStreamModule = null;
    }

    async onStart() {
        const pluginConfig = this.context.getPluginFileConfig();
        const barrageManager = global.barrageManager;
        if (!barrageManager) {
            this.context.log('warn', 'barrageManager is not ready, skipping the live stream module');
            return;
        }

        this._liveStreamModule = new LiveStreamModule({
            roomId: pluginConfig.roomId || 30230160,
            onNewMessage: (message) => {
                barrageManager.addToQueue(message.nickname, message.text);
            },
            onEvent: (event) => {
                if (event.type === 'danmaku') return;
                logToTerminal('info', `Live event received [${event.type}]: ${event.nickname}: ${event.text}`);
                barrageManager.addToQueue(event.nickname, `[${event.type}] ${event.text}`);
            },
            onStatus: (status) => {
                const detail = status.realRoomId ? `, real room ${status.realRoomId}` : '';
                if (status.phase === 'connected') logToTerminal('info', `Bilibili live connection established${detail}`);
                else if (status.phase === 'retrying') logToTerminal('warning', `Bilibili live connection lost, reconnecting: ${status.error}`);
            }
        });

        this._liveStreamModule.start();
    }

    async onStop() {
        if (this._liveStreamModule) {
            this._liveStreamModule.stop();
            this._liveStreamModule = null;
        }
    }
}

module.exports = BilibiliLivePlugin;
