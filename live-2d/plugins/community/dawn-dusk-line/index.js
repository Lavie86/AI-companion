/**
 * 晨昏之线 - 时间感知与整点主动问候插件
 *
 * 职能一：环境感知 —— 每次 LLM 请求可在用户消息前注入时区时间、工作日/周末、法定节假日与调休、时段（对齐 AstrBot LLMPerception 思路）
 * 职能二：被动工具 —— 提供时间查询和问候语时间检查
 * 职能三：主动问候 —— 在设定整点智能发起问候，根据对话活跃度选择策略
 *
 * 节假日数据：chinese-workday（国务院放假安排，与 chinese-calendar 数据源同类）
 * 安装：在插件目录执行 npm install
 *
 * 作者：爱熬夜的人形兔
 * 版本：1.1.0
 */

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { Plugin } = require('../../../js/core/plugin-base.js');

const PATCH_ID = 'dawn-dusk-line-greeting';

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// chinese-workday returns Chinese holiday names; the LLM gets them in English
const FESTIVAL_NAMES = {
    '元旦': "New Year's Day", '春节': 'Spring Festival', '清明节': 'Qingming Festival', '劳动节': 'Labour Day',
    '端午节': 'Dragon Boat Festival', '中秋节': 'Mid-Autumn Festival', '国庆节': 'National Day'
};

/** 与 LLMPerception / 常用习惯一致：上午/中午/下午/晚上/深夜 */
function timePeriodFromHour(hour) {
    if (hour >= 5 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 14) return 'noon';
    if (hour >= 14 && hour < 18) return 'afternoon';
    if (hour >= 18 && hour < 22) return 'evening';
    return 'late night';
}

/**
 * 指定 IANA 时区下的日历分量（与 LLMPerception 一致：精确到秒的时间戳 + 用于节假日判断的当地日期）
 */
function getZonedComponents(date, timeZone) {
    const s = new Intl.DateTimeFormat('sv-SE', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(date);
    const [datePart, timePart] = s.split(/[\sT]/);
    const [hh, mm] = (timePart || '00:00:00').split(':');
    const hour = parseInt(hh, 10);
    const minute = parseInt(mm, 10);
    const weekdayMon0 = getWeekdayMon0(date, timeZone);
    return {
        dateKey: datePart,
        timestr: `${datePart} ${timePart || `${hh}:${mm}:00`}`,
        hour,
        minute,
        weekdayMon0
    };
}

/** 周一=0 … 周日=6（按配置时区的日历日） */
function getWeekdayMon0(date, timeZone) {
    const long = new Intl.DateTimeFormat('zh-CN', { timeZone, weekday: 'long' }).format(date);
    const names = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
    const idx = names.indexOf(long);
    return idx >= 0 ? idx : 0;
}

// 注入系统提示词用：引导 AI 在下次回复中自然融入问候
const GREETING_PROMPTS = {
    0:  'It is now midnight, and it is late. When you next reply to the user, gently remind them to rest and go to bed early, in a warm and caring tone. Do not announce the time like a clock.',
    8:  'It is now 8 in the morning, and a new day has begun. When you next reply to the user, naturally say good morning. You can mention how the morning feels. Keep it lively and warm, and do not announce the time like a clock.',
    12: 'It is now noon, time for lunch. When you next reply to the user, naturally remind them to have lunch and take a break, in a relaxed, everyday tone. Do not announce the time like a clock.',
    18: 'It is now 6 in the evening, and the day is almost over. When you next reply to the user, naturally give an evening greeting. You can ask how their day went. Keep the tone gentle, and do not announce the time like a clock.'
};

// 直接发送用：给 AI 一个情景提示让它自由发挥
const DIRECT_GREETING_HINTS = {
    0:  '(It is midnight now, very late. Check whether they are still up, and gently remind them to get some rest)',
    8:  '(It is 8 in the morning, a new day. Say good morning to them, full of energy)',
    12: '(It is noon now. Remind them it is time for lunch, and show that you care)',
    18: '(It is 6 in the evening, and the day is almost over. Ask them how their day went)'
};

class DawnDuskLinePlugin extends Plugin {

    // ==================== 生命周期 ====================

    async onInit() {
        const cfg = this.context.getPluginFileConfig();

        const hoursStr = cfg.greetingHours ?? '0,8,12,18';
        this._greetingHours = hoursStr.split(',').map(h => parseInt(h.trim(), 10)).filter(h => !isNaN(h));
        this._quietThreshold  = (cfg.quietThreshold  ?? 10) * 60 * 1000;
        this._activeThreshold = (cfg.activeThreshold  ?? 3)  * 60 * 1000;
        this._deferTimeout    = (cfg.deferTimeout     ?? 30) * 60 * 1000;
        this._checkInterval   = (cfg.checkInterval    ?? 30) * 1000;

        // Empty means the computer's own time zone
        this._timezone = cfg.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
        this._enableHoliday = cfg.enableHolidayPerception !== false;
        this._injectPerception = cfg.injectEnvironmentPerception !== false;
        this._holidayCountry = (cfg.holidayCountry || 'CN').toUpperCase();

        this._lastInteractionTime = Date.now();
        this._firedHours = new Set();
        this._checkTimer = null;
        this._deferredGreeting = null;
        this._deferTimer = null;
        this._patchApplied = false;
        this._cnWorkday = null;

        await this._loadChineseWorkday();
    }

    /**
     * chinese-workday 包为 "type":"module"，其 dist 文件名为 *.cjs.js（仍以 .js 结尾），
     * 在包目录内会被当作 ESM，require 会得到空对象；若改用动态 import(巨大 ESM)，
     * 在 Electron 渲染进程曾触发崩溃（exitCode=-36861）。
     * 做法：将 dist 复制到插件目录下纯 .cjs 后缀缓存文件，再 require。
     */
    async _loadChineseWorkday() {
        try {
            const pluginDir = path.dirname(__filename);
            const bundleSrc = path.join(pluginDir, 'node_modules', 'chinese-workday', 'dist', 'chinese-workday.cjs.js');
            const bundleCjs = path.join(pluginDir, '.chinese-workday-bundle.cjs');
            if (!fs.existsSync(bundleSrc)) {
                this._cnWorkday = null;
                return;
            }
            const needCopy =
                !fs.existsSync(bundleCjs) ||
                fs.statSync(bundleSrc).mtimeMs > fs.statSync(bundleCjs).mtimeMs;
            if (needCopy) {
                fs.copyFileSync(bundleSrc, bundleCjs);
            }
            const req = createRequire(__filename);
            const mod = req(bundleCjs);
            if (mod && typeof mod.isHoliday === 'function' && typeof mod.isWorkday === 'function') {
                this._cnWorkday = mod;
                return;
            }
            this.context.log('warn', 'Dawn and Dusk: chinese-workday loaded, but its API is not as expected, so holidays fall back to weekends only');
            this._cnWorkday = null;
        } catch (e) {
            this.context.log('warn',
                `Dawn and Dusk: chinese-workday is not loaded (run npm install in the plugin folder), so holidays fall back to weekends only: ${e.message}`);
            this._cnWorkday = null;
        }
    }

    async onStart() {
        this._onInteraction = () => {
            this._lastInteractionTime = Date.now();
        };

        this.context.on('interaction:updated', this._onInteraction);
        this.context.on('user:message:received', this._onInteraction);

        this._onTTSEnd = () => this._tryFlushDeferred();
        this.context.on('tts:end', this._onTTSEnd);

        this._checkTimer = setInterval(() => this._tick(), this._checkInterval);

        const calOk = this._cnWorkday && this._enableHoliday && this._holidayCountry === 'CN';
        this.context.log('info',
            `Dawn and Dusk started | time zone: ${this._timezone} | add awareness: ${this._injectPerception} | ` +
            `holidays: ${calOk ? 'chinese-workday' : 'weekends only'} | greeting hours: ${this._greetingHours.join(',')} | check interval: ${this._checkInterval / 1000}s`);
    }

    async onStop() {
        if (this._checkTimer) { clearInterval(this._checkTimer); this._checkTimer = null; }
        if (this._deferTimer) { clearInterval(this._deferTimer); this._deferTimer = null; }
        if (this._onInteraction) {
            this.context.off('interaction:updated', this._onInteraction);
            this.context.off('user:message:received', this._onInteraction);
        }
        if (this._onTTSEnd) {
            this.context.off('tts:end', this._onTTSEnd);
        }
        this._removePatch();
    }

    // ==================== 感知行（工具 + LLM 注入） ====================

    _buildPerceptionLine(now = new Date(), tzOverride) {
        const tz = tzOverride || this._timezone;
        const { timestr, hour, dateKey, weekdayMon0 } = getZonedComponents(now, tz);

        const calParts = [WEEKDAY_NAMES[weekdayMon0]];
        const isWeekend = weekdayMon0 >= 5;

        if (this._enableHoliday && this._holidayCountry === 'CN' && this._cnWorkday) {
            const isHol = this._cnWorkday.isHoliday(dateKey);
            const isWork = this._cnWorkday.isWorkday(dateKey);
            let festival = '';
            if (isHol) {
                try {
                    festival = this._cnWorkday.getFestival(dateKey) || '';
                } catch (_) {
                    festival = '';
                }
                festival = FESTIVAL_NAMES[festival] || festival || 'public holiday';
                calParts.push(isWeekend ? `weekend (${festival})` : `public holiday (${festival})`);
            } else if (isWork) {
                calParts.push(isWeekend ? 'make-up workday' : 'workday');
            } else {
                calParts.push('weekend');
            }
        } else {
            calParts.push(isWeekend ? 'weekend' : 'workday');
        }

        calParts.push(timePeriodFromHour(hour));
        return `Sent at: ${timestr} | ${calParts.join(', ')}`;
    }

    _prependToLastUserMessage(messages, prefix) {
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role !== 'user') continue;
            const msg = messages[i];
            if (typeof msg.content === 'string') {
                msg.content = prefix + msg.content;
            } else if (Array.isArray(msg.content)) {
                const textBlock = msg.content.find(c => c.type === 'text');
                if (textBlock) {
                    textBlock.text = prefix + (textBlock.text || '');
                } else {
                    msg.content.unshift({ type: 'text', text: prefix });
                }
            }
            return;
        }
    }

    async onLLMRequest(request) {
        if (this._injectPerception && request.messages?.length) {
            const line = this._buildPerceptionLine();
            this._prependToLastUserMessage(request.messages, `[${line}]\n`);
        }
    }

    // ==================== 工具注册（取代 FC 工具） ====================

    getTools() {
        return [
            {
                type: 'function',
                function: {
                    name: 'dawn_dusk_get_time',
                    description: 'Call this when the user explicitly asks about the current time, date or day of the week, or whether it is a workday or a holiday. Returns the exact timestamp in the configured time zone, the day of the week, workday / make-up workday / public holiday name (if the dependency is installed) and the time of day (morning, noon, afternoon, evening, late night).',
                    parameters: {
                        type: 'object',
                        properties: {
                            timezone: {
                                type: 'string',
                                description: 'IANA time zone (optional, for example Europe/London). Defaults to the plugin setting'
                            }
                        },
                        required: []
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'dawn_dusk_greeting_check',
                    description: 'Call this on your own when the user says a greeting or goodbye tied to the time of day. For example: "good morning", "good evening", "good night", "see you tonight"',
                    parameters: {
                        type: 'object',
                        properties: {},
                        required: []
                    }
                }
            }
        ];
    }

    async executeTool(name, params) {
        switch (name) {
            case 'dawn_dusk_get_time':
            case 'dawn_dusk_greeting_check': {
                const tz = (params && params.timezone) || this._timezone;
                try {
                    const line = this._buildPerceptionLine(new Date(), tz);
                    return line;
                } catch (e) {
                    return `Could not work out the time (check that the time zone is a valid IANA time zone): ${e.message}`;
                }
            }
            default:
                throw new Error(`Dawn and Dusk: unsupported tool ${name}`);
        }
    }

    // ==================== 主动问候系统 ====================

    _tick() {
        const now = new Date();
        const tz = this._timezone;
        const { hour, minute, dateKey: ymd } = getZonedComponents(now, tz);
        const dateKey = `${ymd}-${hour}`;

        const todayPrefix = `${ymd}-`;
        for (const key of this._firedHours) {
            if (!key.startsWith(todayPrefix)) {
                this._firedHours.delete(key);
            }
        }

        if (minute > 5) return;

        if (!this._greetingHours.includes(hour)) return;
        if (this._firedHours.has(dateKey)) return;

        this._firedHours.add(dateKey);
        this._initiateGreeting(hour);
    }

    _initiateGreeting(hour) {
        const elapsed = Date.now() - this._lastInteractionTime;

        try {
            const { appState } = require('../../../js/core/app-state.js');
            if (appState.isPlayingTTS() || appState.isProcessingUserInput()) {
                this.context.log('info', `[Dawn and Dusk] ${hour}:00 greeting → the AI is talking or busy, adding a prompt`);
                this._injectPatch(hour);
                return;
            }
        } catch (_) {}

        if (elapsed < this._activeThreshold) {
            this.context.log('info', `[Dawn and Dusk] ${hour}:00 greeting → chat is active (${Math.round(elapsed / 1000)}s ago), adding a prompt`);
            this._injectPatch(hour);
        } else if (elapsed >= this._quietThreshold) {
            this.context.log('info', `[Dawn and Dusk] ${hour}:00 greeting → chat is quiet (${Math.round(elapsed / 1000)}s ago), greeting right away`);
            this._sendDirectGreeting(hour);
        } else {
            this.context.log('info', `[Dawn and Dusk] ${hour}:00 greeting → chat is half active, waiting for a gap`);
            this._deferGreeting(hour);
        }
    }

    async _sendDirectGreeting(hour) {
        const hint = DIRECT_GREETING_HINTS[hour] || `(It is now ${hour}:00. Say hi naturally)`;
        try {
            const arbiter = global.proactiveArbiter;
            const externalPolicy = arbiter?.externalSourcePolicy?.('dawn-dusk-line');
            if (externalPolicy === 'block') {
                this.context.log('info', '[Dawn and Dusk] The persona director blocked this greeting');
                return;
            }
            if (arbiter?.submitExternal && externalPolicy === 'collect') {
                await arbiter.submitExternal('dawn-dusk-line', hint, {
                    priority: 0.56,
                    topic: `${hour}:00 greeting`,
                    topic_key: `dawn_dusk_${hour}`,
                    render_hint: 'This is a time-of-day greeting. Keep the sense of time, but do not sound like a talking clock.'
                });
                return;
            }
            await this.context.sendMessage(hint);
        } catch (e) {
            this.context.log('error', `[Dawn and Dusk] Failed to send the greeting: ${e.message}`);
        }
    }

    _injectPatch(hour) {
        const prompt = GREETING_PROMPTS[hour] || `It is now ${hour}:00. Work a greeting that fits the time into your next reply, naturally.`;
        this.context.addSystemPromptPatch(PATCH_ID, prompt);
        this._patchApplied = true;
    }

    _removePatch() {
        if (this._patchApplied) {
            this.context.removeSystemPromptPatch(PATCH_ID);
            this._patchApplied = false;
        }
    }

    _deferGreeting(hour) {
        if (this._deferredGreeting) return;
        this._deferredGreeting = { hour, startTime: Date.now() };

        this._deferTimer = setInterval(() => {
            if (!this._deferredGreeting) {
                clearInterval(this._deferTimer);
                this._deferTimer = null;
                return;
            }

            const waitedMs = Date.now() - this._deferredGreeting.startTime;
            if (waitedMs > this._deferTimeout) {
                this.context.log('info', `[Dawn and Dusk] Waited too long (${Math.round(waitedMs / 60000)}min), skipping this greeting`);
                this._deferredGreeting = null;
                clearInterval(this._deferTimer);
                this._deferTimer = null;
                return;
            }

            const elapsed = Date.now() - this._lastInteractionTime;
            if (elapsed >= this._quietThreshold) {
                const h = this._deferredGreeting.hour;
                this._deferredGreeting = null;
                clearInterval(this._deferTimer);
                this._deferTimer = null;
                this.context.log('info', `[Dawn and Dusk] Found a gap in the chat, sending the delayed greeting`);
                this._sendDirectGreeting(h);
            }
        }, 15000);
    }

    _tryFlushDeferred() {
        if (!this._deferredGreeting) return;
        const elapsed = Date.now() - this._lastInteractionTime;
        if (elapsed >= this._quietThreshold) {
            const h = this._deferredGreeting.hour;
            this._deferredGreeting = null;
            if (this._deferTimer) { clearInterval(this._deferTimer); this._deferTimer = null; }
            this.context.log('info', `[Dawn and Dusk] Quiet after TTS finished, sending the delayed greeting`);
            this._sendDirectGreeting(h);
        }
    }

    // ==================== 消息钩子 ====================

    async onLLMResponse(response) {
        if (this._patchApplied) {
            this._removePatch();
        }
    }
}

module.exports = DawnDuskLinePlugin;
