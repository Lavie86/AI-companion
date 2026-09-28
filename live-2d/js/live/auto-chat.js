// 自动对话模块 - 重构版本，复用sendToLLM逻辑
const { appState } = require('../core/app-state.js');
const { eventBus } = require('../core/event-bus.js');
const { Events } = require('../core/events.js');

class AutoChatModule {
   constructor(pluginConfig, mainConfig, ttsProcessor) {
       // 注意：ttsProcessor参数保留但不再直接使用，因为sendToLLM已经处理TTS
       this.pluginConfig = pluginConfig;
       this.timeoutId = null;
       this.isRunning = false;
       this.idleTimeThreshold = (pluginConfig.idle_time || 15) * 1000; // 转换为毫秒
       this.lastInteractionTime = Date.now();
       this.isProcessing = false;

       // 自动截图相关配置
       this.autoScreenshot = mainConfig.vision?.auto_screenshot || false;
       this.screenshotEnabled = mainConfig.vision?.enabled || false;
   }

   start() {
       if (this.isRunning) return;

       console.log(`自动对话启动，间隔：${this.idleTimeThreshold}ms`);
       this.isRunning = true;
       this.lastInteractionTime = Date.now();

       // 监听交互更新事件
       eventBus.on(Events.INTERACTION_UPDATED, () => {
           this.updateLastInteractionTime();
       });

       this.scheduleNext();
   }

   stop() {
       if (this.timeoutId) {
           clearTimeout(this.timeoutId);
           this.timeoutId = null;
       }
       this.isRunning = false;
       this.isProcessing = false;

       // 移除事件监听
       eventBus.off(Events.INTERACTION_UPDATED);
   }

   scheduleNext() {
       if (!this.isRunning) return;

       const nextTime = new Date(Date.now() + this.idleTimeThreshold).toLocaleTimeString();
       console.log(`⏰ 下次主动对话预定在: ${nextTime} (${this.idleTimeThreshold}ms后)`);

       this.timeoutId = setTimeout(() => {
           this.executeChat();
       }, this.idleTimeThreshold);
   }

   // 注意：takeScreenshotBase64方法已移除，现在由sendToLLM统一处理截图

   async executeChat() {
       if (!this.isRunning || this.isProcessing) return;

       // 🔧 调试：打印所有状态
       const playingTTS = appState.isPlayingTTS();
       const processingBarrage = appState.isProcessingBarrage();
       const processingUserInput = appState.isProcessingUserInput();

       // 检查其他活动
       if (playingTTS || processingBarrage || processingUserInput) {
           console.log(`⏸️ 主动对话延迟 - TTS播放:${playingTTS}, 弹幕处理:${processingBarrage}, 用户输入:${processingUserInput}`);
           if (typeof logToTerminal === 'function') {
               logToTerminal('warning', `⏸️ Proactive chat delayed - TTS:${playingTTS}, live chat:${processingBarrage}, input:${processingUserInput}`);
           }
           this.timeoutId = setTimeout(() => this.executeChat(), 5000);
           return;
       }

       this.isProcessing = true;
       console.log('✅ 开始自动对话');
       if (typeof logToTerminal === 'function') {
           logToTerminal('info', '🔧 Starting auto chat');
       }

       try {
           const voiceChat = global.voiceChat;
           if (!voiceChat) {
               console.error('voiceChat不存在');
               return;
           }

           let prompt = `[Auto-triggered] ${this.pluginConfig.prompt || ''}`;

           // 🎯 核心简化：检查是否需要截图，如果需要则修改prompt让sendToLLM处理
           if (this.screenshotEnabled && this.autoScreenshot) {
               console.log('自动截图模式已开启，主动对话将包含截图');
               // 添加特殊标记，让sendToLLM知道需要截图
               prompt = `${prompt} [Screenshot needed]`;

               // 临时设置标志，让sendToLLM知道要截图
               voiceChat._autoScreenshotFlag = true;
           }

           // 🚀 关键简化：直接使用已有的sendToLLM方法！
           console.log('调用统一的sendToLLM方法...');
           await voiceChat.sendToLLM(prompt);

           // 清除截图标志
           if (voiceChat._autoScreenshotFlag) {
               delete voiceChat._autoScreenshotFlag;
           }

           console.log('自动对话完成');

       } catch (error) {
           console.error('自动对话错误:', error);
           if (typeof logToTerminal === 'function') {
               logToTerminal('error', `❌ Auto chat failed: ${error.message}`);
           }
       } finally {
           this.isProcessing = false;
           // 对话完成后，安排下一次
           this.scheduleNext();
       }
   }

   // 注意：waitForTTS方法已移除，因为sendToLLM已经处理了TTS播放

   updateLastInteractionTime() {
       this.lastInteractionTime = Date.now();
       if (this.timeoutId) {
           clearTimeout(this.timeoutId);
           this.scheduleNext();
       }
   }
}

module.exports = { AutoChatModule };