'use strict';

// Where the text box goes: next to her body, on the side of her screen that has more room.
// All rectangles are {left, top, right, bottom} in the pet window's CSS pixels.

const GAP = 12;   // space between her and the box
const EDGE = 12;  // space between the box and the screen edge
const BOTTOM_AT = 0.75; // the box's bottom edge sits this far down her body (about her knees)

function placeChatBox({ model, box, area }) {
    const roomRight = area.right - model.right;
    const roomLeft = model.left - area.left;
    const needed = box.width + GAP + EDGE;

    let left;
    const sides = roomRight >= roomLeft ? ['right', 'left'] : ['left', 'right'];
    const side = sides.find(s => (s === 'right' ? roomRight : roomLeft) >= needed);
    if (side === 'right') left = model.right + GAP;
    else if (side === 'left') left = model.left - GAP - box.width;
    else left = (model.left + model.right - box.width) / 2; // no room beside her: in front of her

    let top = model.top + (model.bottom - model.top) * BOTTOM_AT - box.height;

    // keep the whole box on her screen
    left = Math.max(area.left + EDGE, Math.min(left, area.right - box.width - EDGE));
    top = Math.max(area.top + EDGE, Math.min(top, area.bottom - box.height - EDGE));
    return { left: Math.round(left), top: Math.round(top), side: side || 'front' };
}

// The part of the screen she stands on, in window CSS pixels. Falls back to the whole
// window when the screen list is missing or does not line up with her position.
function screenAreaFor(model, screenInfo, viewport) {
    const whole = { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
    const win = screenInfo && screenInfo.windowBounds;
    const displays = (screenInfo && screenInfo.allDisplays) || [];
    if (!win || displays.length === 0) return whole;

    const cx = (model.left + model.right) / 2;
    const cy = (model.top + model.bottom) / 2;
    for (const display of displays) {
        const r = display.workArea || display.bounds;
        if (!r) continue;
        const area = {
            left: Math.max(whole.left, r.x - win.x),
            top: Math.max(whole.top, r.y - win.y),
            right: Math.min(whole.right, r.x - win.x + r.width),
            bottom: Math.min(whole.bottom, r.y - win.y + r.height)
        };
        if (cx >= area.left && cx < area.right && cy >= area.top && cy < area.bottom) return area;
    }
    return whole;
}

module.exports = { placeChatBox, screenAreaFor };
