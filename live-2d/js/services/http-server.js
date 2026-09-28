const express = require('express');
const { BrowserWindow } = require('electron');

/**
 * HTTP API 服务器
 * 提供音乐控制和情绪控制的 HTTP 接口
 */
class HttpServer {
    constructor() {
        this.musicApp = null;
        this.emotionApp = null;
    }

    /**
     * 启动所有 HTTP 服务
     */
    start() {
        this.startMusicServer();
        this.startEmotionServer();
    }

    /**
     * 启动音乐控制服务器 (端口 3001)
     */
    startMusicServer() {
        this.musicApp = express();
        this.musicApp.use(express.json());

        // 音乐控制接口
        this.musicApp.post('/control-music', (req, res) => {
            const { action, filename } = req.body;
            const mainWindow = BrowserWindow.getAllWindows()[0];

            if (!mainWindow) {
                return res.json({ success: false, message: 'App window not found' });
            }

            let jsCode = '';
            switch (action) {
                case 'play_random':
                    // 直接返回 playRandomMusic 的结果 (Promise)
                    jsCode = 'global.musicPlayer ? global.musicPlayer.playRandomMusic() : { message: "Player not initialized", metadata: null }';
                    break;
                case 'stop':
                    jsCode = 'global.musicPlayer ? global.musicPlayer.stop() : null; "Music stopped"';
                    break;
                case 'play_specific':
                    // 直接返回 playSpecificSong 的结果 (Promise)
                    jsCode = `global.musicPlayer ? global.musicPlayer.playSpecificSong('${filename}') : { message: "Player not initialized", metadata: null }`;
                    break;
                default:
                    return res.json({ success: false, message: 'Unsupported action' });
            }

            mainWindow.webContents.executeJavaScript(jsCode)
                .then(result => res.json({ success: true, message: result }))
                .catch(error => res.json({ success: false, message: error.toString() }));
        });

        this.musicApp.listen(3001, () => {
            console.log('音乐控制服务启动在端口3001');
        });
    }

    /**
     * 启动情绪控制服务器 (端口 3002)
     */
    startEmotionServer() {
        this.emotionApp = express();
        this.emotionApp.use(express.json());

        // 情绪控制接口
        this.emotionApp.post('/control-motion', (req, res) => {
            const { action, emotion_name, motion_index } = req.body;
            const mainWindow = BrowserWindow.getAllWindows()[0];

            if (!mainWindow) {
                return res.json({ success: false, message: 'App window not found' });
            }

            let jsCode = '';

            if (action === 'trigger_emotion') {
                // 调用情绪映射器播放情绪动作
                jsCode = `
                    if (global.emotionMapper && global.emotionMapper.playConfiguredEmotion) {
                        global.emotionMapper.playConfiguredEmotion('${emotion_name}');
                        "Triggered emotion: ${emotion_name}";
                    } else {
                        "Emotion mapper not initialized";
                    }
                `;
            } else if (action === 'trigger_motion') {
                // 保留原有的索引方式（兼容性）
                jsCode = `
                    if (global.emotionMapper && global.emotionMapper.playMotion) {
                        global.emotionMapper.playMotion(${motion_index});
                        "Triggered motion index: ${motion_index}";
                    } else {
                        "Emotion mapper not initialized";
                    }
                `;
            } else if (action === 'stop_all_motions') {
                // 停止所有动作
                jsCode = `
                    if (currentModel && currentModel.internalModel && currentModel.internalModel.motionManager) {
                        currentModel.internalModel.motionManager.stopAllMotions();
                        if (global.emotionMapper) {
                            global.emotionMapper.playDefaultMotion();
                        }
                        "Stopped all motions";
                    } else {
                        "Model not initialized";
                    }
                `;
            } else {
                return res.json({ success: false, message: 'Unsupported action' });
            }

            mainWindow.webContents.executeJavaScript(jsCode)
                .then(result => res.json({ success: true, message: result }))
                .catch(error => res.json({ success: false, message: error.toString() }));
        });

        

        // 表情控制接口
        this.emotionApp.post('/control-expression', (req, res) => {
            const { expression_name } = req.body;
            const mainWindow = BrowserWindow.getAllWindows()[0];

            if (!mainWindow) {
                return res.json({ success: false, message: 'App window not found' });
            }

            const jsCode = `
                if (global.expressionMapper && global.expressionMapper.triggerExpression) {
                    global.expressionMapper.triggerExpression('${expression_name}');
                    "Triggered expression: ${expression_name}";
                } else {
                    "Expression mapper not initialized";
                }
            `;

            mainWindow.webContents.executeJavaScript(jsCode)
                .then(result => res.json({ success: true, message: result }))
                .catch(error => res.json({ success: false, message: error.toString() }));
        });
        
        // 表情绑定接口
        this.emotionApp.post('/bind-expression', (req, res) => {
            const { expression_name, emotion_name } = req.body;
            const mainWindow = BrowserWindow.getAllWindows()[0];

            if (!mainWindow) {
                return res.json({ success: false, message: 'App window not found' });
            }

            const jsCode = `
                if (global.expressionMapper && global.expressionMapper.bindExpressionToEmotion) {
                    const result = global.expressionMapper.bindExpressionToEmotion('${emotion_name}', '${expression_name}');
                    result ? "Bound" : "Expression already bound";
                } else {
                    "Expression mapper not initialized";
                }
            `;

            mainWindow.webContents.executeJavaScript(jsCode)
                .then(result => res.json({ success: true, message: result }))
                .catch(error => res.json({ success: false, message: error.toString() }));
        });

        // 配置重新加载接口
        this.emotionApp.post('/reload-config', (req, res) => {
            const mainWindow = BrowserWindow.getAllWindows()[0];

            if (!mainWindow) {
                return res.json({ success: false, message: 'App window not found' });
            }

            // 重载 config.json，同时让情绪引擎重读表情/动作绑定（控制面板 / WebUI 保存后调用，无需重启桌宠）
            const jsCode = `
               (async () => {
                    const reloaded = global.reloadConfig ? global.reloadConfig() : false;
                    const engines = new Set();
                    for (const mapper of [global.emotionMapper, global.expressionMapper]) {
                        if (mapper && typeof mapper.reloadConfig === 'function') engines.add(mapper._engine || mapper);
                    }
                    for (const engine of engines) await engine.reloadConfig();
                    return reloaded ? "Config reloaded" : "Config reload function not found";
                })()
            `;

            mainWindow.webContents.executeJavaScript(jsCode)
                .then(result => res.json({ success: true, message: result }))
                .catch(error => res.json({ success: false, message: error.toString() }));
        });

        // 热复位模型端点
		this.emotionApp.post('/reset-model-position', async (req, res) => {
		    const mainWindow = BrowserWindow.getAllWindows()[0];
		    if (!mainWindow) {
		        return res.json({ success: false});
		    }
		
		    const jsCode = `
		        (() => {
		            const facade = global.avatarFacade || window.avatar;
		            const mc = facade?.getController?.() || global.modelController;
		            if (!mc) return { success: false };

		            if (typeof mc.resetModelPosition === 'function') {
		                const result = mc.resetModelPosition();
		                const uic = global.uiController;
		                if (uic) uic.resetSubtitlePosition();
		                return result && result.success !== false ? { success: true } : { success: false };
		            }

		            return { success: false };
		        })()
		    `;
		
		    try {
		        const result = await mainWindow.webContents.executeJavaScript(jsCode);
		        res.json(result);
		    } catch (error) {
		        res.json({ success: false, message: error.toString() });
		    }
		});
        // 模型切换接口（供QT前端调用）
        this.emotionApp.post('/switch-model', (req, res) => {
            const { model_name, model_type } = req.body;
            const mainWindow = BrowserWindow.getAllWindows()[0];

            if (!mainWindow) {
                return res.json({ success: false, message: 'App window not found' });
            }

            if (model_type === 'vrm') {
                // VRM模型切换：通过IPC触发
                mainWindow.webContents.executeJavaScript(
                    `require('electron').ipcRenderer.invoke('switch-vrm-model', ${JSON.stringify(model_name)})`
                ).then(() => {
                    res.json({ success: true, message: `VRM model switched to ${model_name}` });
                }).catch(error => {
                    res.json({ success: false, message: error.toString() });
                });
            } else {
                // Live2D模型切换
                mainWindow.webContents.executeJavaScript(
                    `require('electron').ipcRenderer.invoke('switch-live2d-model', ${JSON.stringify(model_name)})`
                ).then(() => {
                    res.json({ success: true, message: `Model switched to ${model_name}` });
                }).catch(error => {
                    res.json({ success: false, message: error.toString() });
                });
            }
        });

        // 皮套形态切换接口（供 WebUI 调用）：桥接到 Electron 主进程的统一切换事务
        // 主进程侧的 avatar-switch-transaction 已处理跨渲染引擎的整窗重载与回滚
        this.emotionApp.post('/switch-avatar-type', (req, res) => {
            const { type } = req.body || {};
            const mainWindow = BrowserWindow.getAllWindows()[0];

            if (!mainWindow) {
                return res.json({ success: false, message: 'App window not found' });
            }
            if (!type) {
                return res.json({ success: false, message: 'Missing the type parameter' });
            }

            mainWindow.webContents.executeJavaScript(
                `require('electron').ipcRenderer.invoke('avatar:switch-type', ${JSON.stringify(type)})`
            ).then(result => {
                res.json(result && typeof result === 'object'
                    ? result
                    : { success: !!result, message: `Avatar type switched to ${type}` });
            }).catch(error => {
                res.json({ success: false, message: error.toString() });
            });
        });

        // 指定形态下的模型选择接口（供 WebUI 调用）：热应用并持久化
        this.emotionApp.post('/set-avatar-model', (req, res) => {
            const { type, model_name } = req.body || {};
            const mainWindow = BrowserWindow.getAllWindows()[0];

            if (!mainWindow) {
                return res.json({ success: false, message: 'App window not found' });
            }
            if (!type || !model_name) {
                return res.json({ success: false, message: 'Missing the type or model_name parameter' });
            }

            mainWindow.webContents.executeJavaScript(
                `require('electron').ipcRenderer.invoke('avatar:set-model', { type: ${JSON.stringify(type)}, model_name: ${JSON.stringify(model_name)} })`
            ).then(result => {
                res.json(result && typeof result === 'object'
                    ? result
                    : { success: !!result, message: `Model applied: ${model_name}` });
            }).catch(error => {
                res.json({ success: false, message: error.toString() });
            });
        });

        // 桌宠退出前播放淡出动画，控制端收到完成响应后再结束进程。
        this.emotionApp.post('/prepare-close', async (_req, res) => {
            const mainWindow = BrowserWindow.getAllWindows()[0];
            if (!mainWindow) return res.json({ success: false, message: 'App window not found' });
            try {
                const result = await mainWindow.webContents.executeJavaScript(
                    `require('./js/avatar/transition-overlay.js').fadeOut().then(() => ({ success: true }))`
                );
                res.json(result);
            } catch (error) {
                res.json({ success: false, message: error.toString() });
            }
        });

        // 复位字幕位置接口（供 WebUI 调用）：桌宠在线时实时复位并清除已保存的位置
        this.emotionApp.post('/reset-subtitle-position', async (req, res) => {
            const mainWindow = BrowserWindow.getAllWindows()[0];
            if (!mainWindow) {
                return res.json({ success: false, message: 'App window not found' });
            }

            const jsCode = `(() => {
                const uic = global.uiController;
                if (!uic?.resetSubtitlePosition) return { success: false, message: 'Subtitle controller not initialized' };
                uic.resetSubtitlePosition();
                return { success: true, message: 'Subtitle position reset' };
            })()`;

            try {
                const result = await mainWindow.webContents.executeJavaScript(jsCode);
                res.json(result && typeof result === 'object'
                    ? result
                    : { success: !!result });
            } catch (error) {
                res.json({ success: false, message: error.toString() });
            }
        });

        // VMC控制端点
        this._setupVMCEndpoint();

        // ===== 插件管理接口 =====

        this.emotionApp.get('/plugins', (req, res) => {
            const pm = global.pluginManager;
            if (!pm) return res.json({ success: false, message: 'Plugin manager not initialized' });
            res.json({ success: true, plugins: pm.getPluginList() });
        });

        this.emotionApp.post('/plugins/reload', (req, res) => {
            const pm = global.pluginManager;
            if (!pm) return res.json({ success: false, message: 'Plugin manager not initialized' });
            const { name } = req.body || {};
            if (!name) return res.json({ success: false, message: 'Missing the name parameter' });
            pm.reload(name)
                .then(() => res.json({ success: true, message: `Plugin ${name} reloaded` }))
                .catch(e => res.json({ success: false, message: e.message }));
        });

        this.emotionApp.post('/plugins/reload-all', (req, res) => {
            const pm = global.pluginManager;
            if (!pm) return res.json({ success: false, message: 'Plugin manager not initialized' });
            pm.reloadAll()
                .then(() => res.json({ success: true, message: 'All plugins reloaded' }))
                .catch(e => res.json({ success: false, message: e.message }));
        });

        this.emotionApp.post('/plugins/sync', (req, res) => {
            const pm = global.pluginManager;
            if (!pm) return res.json({ success: false, message: 'Plugin manager not initialized' });
            pm.syncEnabledPlugins()
                .then(() => res.json({ success: true, message: 'Plugin list synced' }))
                .catch(e => res.json({ success: false, message: e.message }));
        });

        // 字幕位置调整端点
        this.emotionApp.post('/adjust-subtitle-position', async (req, res) => {
            const mainWindow = BrowserWindow.getAllWindows()[0];
            if (!mainWindow) {
                return res.json({ success: false, message: 'App window not found' });
            }

            const jsCode = `(() => {
                const uic = global.uiController;
                if (!uic?.enterSubtitleAdjustMode) return false;
                uic.enterSubtitleAdjustMode();
                return true;
            })()`;

            try {
                const ok = await mainWindow.webContents.executeJavaScript(jsCode);
                res.json(ok
                    ? { success: true, message: 'Subtitle adjust mode on' }
                    : { success: false, message: 'Subtitle controller not initialized' });
            } catch (error) {
                res.json({ success: false, message: error.toString() });
            }
        });

        this.emotionApp.listen(3002, () => {
            console.log('情绪控制服务启动在端口3002');
        });
    }

    /**
     * 启动VMC控制端点（挂载到情绪控制服务器）
     * 供QT前端实时控制VMC发送器
     */
    _setupVMCEndpoint() {
        if (!this.emotionApp) return;

        this.emotionApp.post('/control-vmc', (req, res) => {
            const { enabled, host, port } = req.body;
            const mainWindow = BrowserWindow.getAllWindows()[0];

            if (!mainWindow) {
                return res.json({ success: false, message: 'App window not found' });
            }

            // 净化输入
            const safeHost = String(host || '127.0.0.1').replace(/[^a-zA-Z0-9.\-:]/g, '');
            const safePort = parseInt(port) || 39539;
            const hasEnabled = typeof enabled === 'boolean';

            const jsCode = `
               (function() {
                    if (!global.currentVRMAdapter) return 'No VRM model in use';
                    const sender = global.currentVRMAdapter.getVMCSender();
                    if (!sender) return 'VMC sender not initialized';

                    sender.setTarget('${safeHost}', ${safePort});

                    ${hasEnabled ? `
                    sender.enabled = ${!!enabled};
                    if (${!!enabled}) {
                        if (!sender.socket) sender.start();
                        return 'VMC on → ${safeHost}:${safePort}';
                    } else {
                        sender.stop();
                        return 'VMC off';
                    }
                    ` : `
                    return 'VMC target updated → ${safeHost}:${safePort}';
                    `}
                })();
            `;

            mainWindow.webContents.executeJavaScript(jsCode)
                .then(result => res.json({ success: true, message: result }))
                .catch(error => res.json({ success: false, message: error.toString() }));
        });
    }
}

module.exports = { HttpServer };
