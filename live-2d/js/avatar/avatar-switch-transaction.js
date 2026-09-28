'use strict';

const AVATAR_TYPES = new Set(['live2d', 'vrm', 'mmd', 'pngtuber']);

function normalizeAvatarType(value) {
    const type = String(value || '').trim().toLowerCase();
    return AVATAR_TYPES.has(type) ? type : null;
}

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

class AvatarSwitchTransaction {
    constructor(options = {}) {
        const required = [
            'readModelType',
            'updateModelType',
            'hasAvatarModel',
            'requestRendererSwitch',
            'publishModelType',
            'scheduleReload'
        ];
        for (const name of required) {
            if (typeof options[name] !== 'function') {
                throw new Error(`AvatarSwitchTransaction requires ${name}()`);
            }
        }

        this.readModelType = options.readModelType;
        this.updateModelType = options.updateModelType;
        this.hasAvatarModel = options.hasAvatarModel;
        this.requestRendererSwitch = options.requestRendererSwitch;
        this.publishModelType = options.publishModelType;
        this.scheduleReload = options.scheduleReload;
        this.log = typeof options.log === 'function' ? options.log : () => {};
        this.readyTimeoutMs = Number.isFinite(Number(options.readyTimeoutMs))
            ? Math.max(1000, Number(options.readyTimeoutMs))
            : 30000;
        this.setTimer = options.setTimer || setTimeout;
        this.clearTimer = options.clearTimer || clearTimeout;
        this._switchingWindows = new Set();
        this._pendingReloads = new Map();
    }

    async switchType(targetType, context = {}) {
        const target = normalizeAvatarType(targetType);
        const windowId = context.windowId;
        if (windowId === undefined || windowId === null) {
            return { success: false, phase: 'failed', message: 'Missing the window ID for the switch' };
        }
        if (!target) {
            return { success: false, phase: 'failed', message: `Unknown avatar type: ${targetType}` };
        }
        if (this._switchingWindows.has(windowId) || this._pendingReloads.has(windowId)) {
            return { success: false, phase: 'busy', targetType: target, message: 'An avatar type switch is already in progress' };
        }

        this._switchingWindows.add(windowId);
        try {
            if (!await this.hasAvatarModel(target, context)) {
                return {
                    success: false,
                    phase: 'failed',
                    targetType: target,
                    message: `${target} avatar type has no models, not switched`
                };
            }

            const previous = normalizeAvatarType(await this.readModelType(context)) || 'live2d';
            if (previous === target) {
                return {
                    success: true,
                    phase: 'ready',
                    targetType: target,
                    activeType: target,
                    reloadRequired: false,
                    message: `Already using the ${target} avatar type`
                };
            }

            try {
                await this.updateModelType(target, context);
            } catch (error) {
                return {
                    success: false,
                    phase: 'failed',
                    targetType: target,
                    activeType: previous,
                    message: `Failed to save the target avatar type: ${errorMessage(error)}`
                };
            }

            let rendererResult;
            try {
                rendererResult = await this.requestRendererSwitch(target, context);
            } catch (error) {
                const rollback = await this._rollbackModelType(previous, context);
                return {
                    success: false,
                    phase: rollback.success ? 'rolled-back' : 'failed',
                    targetType: target,
                    activeType: previous,
                    restored: rollback.success,
                    message: rollback.success
                        ? `Could not notify the renderer, restored ${previous}: ${errorMessage(error)}`
                        : `Could not notify the renderer, and the config rollback failed: ${rollback.message}`
                };
            }

            if (rendererResult?.success === true && rendererResult?.reloadRequired !== true) {
                await this.publishModelType(target, context);
                return {
                    success: true,
                    phase: 'ready',
                    targetType: target,
                    activeType: normalizeAvatarType(rendererResult.activeType) || target,
                    reloadRequired: false,
                    message: rendererResult.message || `Switched to ${target}`
                };
            }

            if (rendererResult?.success === true && rendererResult?.reloadRequired === true) {
                await this.publishModelType(target, context);
                try {
                    await this._queueReload({
                        context,
                        previousType: previous,
                        targetType: target,
                        expectedType: target,
                        rollbackAttempted: false,
                        reason: rendererResult.message || 'Switch across render engines'
                    });
                } catch (error) {
                    const rollback = await this._rollbackModelType(previous, context);
                    if (rollback.success) await this.publishModelType(previous, context);
                    return {
                        success: false,
                        phase: rollback.success ? 'rolled-back' : 'failed',
                        targetType: target,
                        activeType: previous,
                        restored: rollback.success,
                        message: rollback.success
                            ? `Could not schedule the window reload, restored ${previous}: ${errorMessage(error)}`
                            : `Could not schedule the window reload, and the config rollback failed: ${rollback.message}`
                    };
                }
                return {
                    success: true,
                    phase: 'reload-scheduled',
                    targetType: target,
                    activeType: normalizeAvatarType(rendererResult.activeType) || previous,
                    reloadRequired: true,
                    message: rendererResult.message || `Scheduled a reload to switch to ${target}`
                };
            }

            const rollback = await this._rollbackModelType(previous, context);
            if (!rollback.success) {
                return {
                    success: false,
                    phase: 'failed',
                    targetType: target,
                    activeType: normalizeAvatarType(rendererResult?.activeType),
                    restored: false,
                    message: `Switch failed, and the config rollback failed: ${rollback.message}`
                };
            }
            await this.publishModelType(previous, context);

            const rendererRestored = rendererResult?.restored === true;
            const rendererUncertain = rendererResult?.reloadRequired === true
                || rendererResult?.timedOut === true
                || !rendererRestored;
            if (rendererUncertain) {
                try {
                    await this._queueReload({
                        context,
                        previousType: previous,
                        targetType: target,
                        expectedType: previous,
                        rollbackAttempted: true,
                        reason: rendererResult?.message || 'Restoring the old avatar type after a failed switch'
                    });
                } catch (error) {
                    return {
                        success: false,
                        phase: 'rolled-back',
                        targetType: target,
                        activeType: rendererRestored ? previous : null,
                        restored: rendererRestored,
                        message: `Config restored to ${previous}, but the window reload could not be scheduled: ${errorMessage(error)}`
                    };
                }
                return {
                    success: false,
                    phase: 'reload-scheduled',
                    targetType: target,
                    activeType: rendererRestored ? previous : null,
                    restored: rendererRestored,
                    reloadRequired: true,
                    message: rendererResult?.message || `Switch failed, reloading to restore ${previous}`
                };
            }

            return {
                success: false,
                phase: 'rolled-back',
                targetType: target,
                activeType: previous,
                restored: true,
                reloadRequired: false,
                message: rendererResult?.message || `Switch failed, restored ${previous}`
            };
        } finally {
            this._switchingWindows.delete(windowId);
        }
    }

    async handleRuntimeReady(payload = {}) {
        const windowId = payload.windowId;
        const activeType = normalizeAvatarType(payload.activeType);
        const pending = this._pendingReloads.get(windowId);

        if (!pending) {
            return {
                success: payload.success === true,
                phase: payload.success === true ? 'ready' : 'failed',
                activeType,
                matchedPending: false,
                message: payload.message || (payload.success === true ? 'Runtime ready' : 'Runtime failed to start')
            };
        }

        if (payload.success === true && activeType === pending.expectedType) {
            this._clearPending(windowId);
            this.log('info', `Avatar reload ready: ${activeType}`);
            return {
                success: true,
                phase: 'ready',
                targetType: pending.targetType,
                activeType,
                matchedPending: true,
                message: `${activeType} avatar type ready`
            };
        }

        return this._recoverPendingReload(
            pending,
            payload.message || `Runtime ready with the wrong type: expected=${pending.expectedType}, actual=${activeType || 'none'}`
        );
    }

    hasPendingReload(windowId) {
        return this._pendingReloads.has(windowId);
    }

    clearWindow(windowId) {
        this._clearPending(windowId);
        this._switchingWindows.delete(windowId);
    }

    dispose() {
        for (const windowId of Array.from(this._pendingReloads.keys())) {
            this._clearPending(windowId);
        }
        this._switchingWindows.clear();
    }

    async _rollbackModelType(previousType, context) {
        try {
            await this.updateModelType(previousType, context);
            return { success: true };
        } catch (error) {
            return { success: false, message: errorMessage(error) };
        }
    }

    async _queueReload(pending) {
        const windowId = pending.context.windowId;
        this._clearPending(windowId);
        const entry = { ...pending, timer: null };
        this._pendingReloads.set(windowId, entry);
        this._armReadyTimeout(entry);
        try {
            await this.scheduleReload({
                context: entry.context,
                expectedType: entry.expectedType,
                targetType: entry.targetType,
                reason: entry.reason
            });
        } catch (error) {
            this._clearPending(windowId);
            throw error;
        }
    }

    _armReadyTimeout(pending) {
        if (pending.timer) this.clearTimer(pending.timer);
        pending.timer = this.setTimer(() => {
            this._recoverPendingReload(
                pending,
                `Waited ${this.readyTimeoutMs}ms without the runtime reporting ready`
            ).then((result) => {
                this.log(result.success ? 'info' : 'error', result.message);
            }).catch((error) => {
                this.log('error', `Avatar ready timeout recovery failed: ${errorMessage(error)}`);
            });
        }, this.readyTimeoutMs);
        pending.timer?.unref?.();
    }

    async _recoverPendingReload(pending, reason) {
        const windowId = pending.context.windowId;
        if (pending.rollbackAttempted) {
            this._clearPending(windowId);
            return {
                success: false,
                phase: 'failed',
                targetType: pending.targetType,
                activeType: null,
                restored: false,
                message: `${reason}; automatic recovery was already tried once, no more reloads`
            };
        }

        const rollback = await this._rollbackModelType(pending.previousType, pending.context);
        if (!rollback.success) {
            this._clearPending(windowId);
            return {
                success: false,
                phase: 'failed',
                targetType: pending.targetType,
                activeType: null,
                restored: false,
                message: `${reason}; config rollback failed: ${rollback.message}`
            };
        }
        await this.publishModelType(pending.previousType, pending.context);

        pending.expectedType = pending.previousType;
        pending.rollbackAttempted = true;
        pending.reason = reason;
        this._armReadyTimeout(pending);
        try {
            await this.scheduleReload({
                context: pending.context,
                expectedType: pending.previousType,
                targetType: pending.targetType,
                reason
            });
        } catch (error) {
            this._clearPending(windowId);
            return {
                success: false,
                phase: 'rolled-back',
                targetType: pending.targetType,
                activeType: null,
                restored: false,
                message: `${reason}; config rolled back, but the recovery reload could not be scheduled: ${errorMessage(error)}`
            };
        }

        return {
            success: false,
            phase: 'rollback-reload-scheduled',
            targetType: pending.targetType,
            activeType: null,
            restored: false,
            reloadRequired: true,
            message: `${reason}; config rolled back and a recovery reload scheduled`
        };
    }

    _clearPending(windowId) {
        const pending = this._pendingReloads.get(windowId);
        if (pending?.timer) this.clearTimer(pending.timer);
        this._pendingReloads.delete(windowId);
    }
}

module.exports = {
    AVATAR_TYPES,
    AvatarSwitchTransaction,
    normalizeAvatarType
};
