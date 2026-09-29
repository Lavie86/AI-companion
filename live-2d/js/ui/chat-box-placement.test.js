'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { placeChatBox, screenAreaFor } = require('./chat-box-placement.js');

const BOX = { width: 350, height: 60 };
const SCREEN = { left: 0, top: 0, right: 1920, bottom: 1040 };

describe('placeChatBox', () => {
    it('puts the box on her left when she stands near the right edge', () => {
        const model = { left: 1500, top: 300, right: 1800, bottom: 1000 };
        const pos = placeChatBox({ model, box: BOX, area: SCREEN });
        assert.equal(pos.side, 'left');
        assert.equal(pos.left, 1500 - 12 - 350);
        assert.equal(pos.top, 300 + 700 * 0.75 - 60);
    });

    it('puts the box on her right when she stands near the left edge', () => {
        const model = { left: 100, top: 300, right: 400, bottom: 1000 };
        const pos = placeChatBox({ model, box: BOX, area: SCREEN });
        assert.equal(pos.side, 'right');
        assert.equal(pos.left, 412);
    });

    it('puts the box in front of her when there is no room beside her', () => {
        const model = { left: 100, top: 0, right: 1820, bottom: 1040 };
        const pos = placeChatBox({ model, box: BOX, area: SCREEN });
        assert.equal(pos.side, 'front');
        assert.equal(pos.left, Math.round((100 + 1820 - 350) / 2));
    });

    it('keeps the box on her screen', () => {
        const model = { left: 2000, top: 900, right: 2300, bottom: 1600 };
        const area = { left: 1920, top: 0, right: 3840, bottom: 1080 };
        const pos = placeChatBox({ model, box: BOX, area });
        assert.ok(pos.left >= area.left + 12 && pos.left + BOX.width <= area.right - 12);
        assert.ok(pos.top >= area.top + 12 && pos.top + BOX.height <= area.bottom - 12);
    });
});

describe('screenAreaFor', () => {
    const viewport = { width: 3840, height: 1080 };

    it('picks the screen she stands on, in window pixels', () => {
        const screenInfo = {
            windowBounds: { x: -1920, y: 0, width: 3840, height: 1080 },
            allDisplays: [
                { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
                { bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 0, width: 1920, height: 1040 } }
            ]
        };
        const onLeftScreen = { left: 300, top: 400, right: 600, bottom: 1000 };
        assert.deepEqual(screenAreaFor(onLeftScreen, screenInfo, viewport), { left: 0, top: 0, right: 1920, bottom: 1040 });
        const onRightScreen = { left: 3000, top: 400, right: 3300, bottom: 1000 };
        assert.deepEqual(screenAreaFor(onRightScreen, screenInfo, viewport), { left: 1920, top: 0, right: 3840, bottom: 1040 });
    });

    it('falls back to the whole window without screen information', () => {
        const model = { left: 300, top: 400, right: 600, bottom: 1000 };
        assert.deepEqual(screenAreaFor(model, null, viewport), { left: 0, top: 0, right: 3840, bottom: 1080 });
        assert.deepEqual(screenAreaFor(model, { windowBounds: { x: 0, y: 0 }, allDisplays: [] }, viewport),
            { left: 0, top: 0, right: 3840, bottom: 1080 });
    });
});
