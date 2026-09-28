// ScreenshotManager.js - 截图管理模块
const { ipcRenderer } = require('electron');
const nodeNet = require('node:net');
const { logToTerminal } = require('../api-utils.js');

class ScreenshotManager {
    constructor(voiceChatInterface) {
        this.voiceChat = voiceChatInterface;
        this.screenshotEnabled = voiceChatInterface.screenshotEnabled;
        this.autoScreenshot = voiceChatInterface.autoScreenshot;

        // 根据配置选择本地或云端模式
        this.bertUrl = 'http://127.0.0.1:6007/classify';
        this.bertApiKey = null;
    }

    // 判断是否需要截图
    async shouldTakeScreenshot(text) {
        if (!this.screenshotEnabled) return false;

        // 🎯 优先检查自动对话模块的截图标志
        if (this.voiceChat._autoScreenshotFlag) {
            console.log('自动对话模块要求截图');
            return true;
        }

        if (this.autoScreenshot) {
            console.log('自动截图模式已开启，将为本次对话截图');
            return true;
        }

        // 检查文本中是否包含截图标记
        if (text.includes('[需要截图]')) {
            console.log('检测到截图标记，将进行截图');
            return true;
        }

        try {
            const result = await this.callBertClassifier(text);
            if (result) {
                const needVision = result["Vision"] === "是";
                if (needVision) logToTerminal('info', 'Screenshot needed');
                return needVision;
            }
            return false;
        } catch (error) {
            console.error('判断截图错误:', error);
            return false;
        }
    }

    // 统一调用BERT分类API的方法
    async callBertClassifier(text) {
        if (!(await this.isLocalBertAvailable())) return null;
        try {
            const headers = {
                'Content-Type': 'application/json'
            };

            // 如果是云端模式，添加 API Key
            if (this.bertApiKey) {
                headers['X-API-Key'] = this.bertApiKey;
            }

            const response = await fetch(this.bertUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    text: text
                })
            });

            if (!response.ok) {
                await this.handleBertError(response);
                return null;
            }

            const data = await response.json();
            return data;
        } catch (error) {
            logToTerminal('error', `BERT classification error: ${error.message}`);
            console.error('BERT分类错误:', error);
            return null;
        }
    }

    isLocalBertAvailable() {
        return new Promise(resolve => {
            const socket = nodeNet.createConnection({ host: '127.0.0.1', port: 6007 });
            const finish = available => {
                socket.removeAllListeners();
                socket.destroy();
                resolve(available);
            };
            socket.setTimeout(250);
            socket.once('connect', () => finish(true));
            socket.once('timeout', () => finish(false));
            socket.once('error', () => finish(false));
        });
    }

    // 截图功能
    async takeScreenshotBase64() {
        try {
            const base64Image = await ipcRenderer.invoke('take-screenshot');
            console.log('截图已完成');
            return base64Image;
        } catch (error) {
            console.error('截图错误:', error);
            throw error;
        }
    }

    // 统一的BERT错误处理
    async handleBertError(response) {
        let errorDetail = "";
        try {
            const errorBody = await response.text();
            try {
                const errorJson = JSON.parse(errorBody);
                errorDetail = JSON.stringify(errorJson, null, 2);
            } catch (e) {
                errorDetail = errorBody;
            }
        } catch (e) {
            errorDetail = "Could not read the error details";
        }

        const serviceName = this.bertApiKey ? 'Feiniu cloud gateway BERT' : 'Local BERT';
        let errorMessage = "";
        switch (response.status) {
            case 401:
                errorMessage = `[${serviceName}] API key rejected. Check that your API key is correct`;
                break;
            case 403:
                errorMessage = `[${serviceName}] API access denied. Your account may be restricted or out of credit`;
                break;
            case 429:
                errorMessage = `[${serviceName}] Too many requests. You hit the API rate limit or ran out of credit`;
                break;
            case 500:
            case 502:
            case 503:
            case 504:
                errorMessage = `[${serviceName}] Server error. The AI service is unavailable right now`;
                break;
            default:
                errorMessage = `[${serviceName}] API error: ${response.status} ${response.statusText}`;
        }

        const fullError = `${errorMessage}\nDetails: ${errorDetail}`;
        logToTerminal('error', fullError);
        console.error(errorMessage);
    }
}

module.exports = { ScreenshotManager };
