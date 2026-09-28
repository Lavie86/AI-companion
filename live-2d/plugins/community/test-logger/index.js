// plugins/community/test-logger/index.js
// 框架验证插件：测试各个钩子是否正常被调用

const { Plugin } = require('../../../js/core/plugin-base.js');

class TestLoggerPlugin extends Plugin {

    async onStart() {
        this.context.log('info', '===== Test plugin started =====');
        this.context.log('info', `Plugin config: ${JSON.stringify(this.context.getPluginConfig())}`);

        // 测试 storage
        this.context.storage.set('start_time', Date.now());
        this.context.log('info', `storage write succeeded, start time: ${new Date().toLocaleTimeString()}`);
    }

    async onUserInput(event) {
        this.context.log('info', `[onUserInput] source=${event.source} text="${event.text}"`);

        // 测试 addContext：给这次 LLM 请求悄悄追加一句话
        event.addContext('(Added by the test plugin: current time ' + new Date().toLocaleTimeString() + ')');
        this.context.log('info', '[onUserInput] Context added');
    }

    async onLLMResponse(response) {
        this.context.log('info', `[onLLMResponse] AI reply, ${response.text.length} chars: "${response.text.substring(0, 30)}..."`);
    }

    async onTTSEnd() {
        const startTime = this.context.storage.get('start_time');
        const uptime = Math.round((Date.now() - startTime) / 1000);
        this.context.log('info', `[onTTSEnd] TTS finished, plugin has been running for ${uptime} seconds`);
    }

    async onStop() {
        this.context.log('info', '===== Test plugin stopped =====');
    }
}

module.exports = TestLoggerPlugin;
