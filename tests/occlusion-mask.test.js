'use strict';
/*
 * 遮挡框（0–1 归一化矩形）的坐标工具：编辑器拖动/缩放与导入校验共用同一套口径，保证「所见即所导」。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../public/core');

test('遮挡框：越界自动夹回，不会产生负坐标或超出图片的框', () => {
  assert.deepEqual(core.clampMask({ x: -0.2, y: -0.5, w: 0.4, h: 0.3 }), { x: 0, y: 0, w: 0.4, h: 0.3 });
  assert.deepEqual(core.clampMask({ x: 0.9, y: 0.9, w: 0.4, h: 0.4 }), { x: 0.9, y: 0.9, w: 0.1, h: 0.1 }, '缩放（默认）：贴着右边就只剩这么多宽度');
  assert.deepEqual(core.clampMask({ x: 0.9, y: 0.9, w: 0.4, h: 0.4 }, 'move'), { x: 0.6, y: 0.6, w: 0.4, h: 0.4 }, '拖动：保尺寸、停在边上');
});

test('遮挡框：过小的框会被抬到最小尺寸（免得点一下就没了）', () => {
  const tiny = core.clampMask({ x: 0.5, y: 0.5, w: 0.001, h: 0 });
  assert.equal(tiny.w, core.MASK_MIN);
  assert.equal(tiny.h, core.MASK_MIN);
  assert.ok(tiny.x + tiny.w <= 1 && tiny.y + tiny.h <= 1);
});

test('遮挡框：拖动只改位置，缩放只改尺寸，都不越界', () => {
  const base = { x: 0.2, y: 0.2, w: 0.3, h: 0.3 };
  assert.deepEqual(core.moveMask(base, 0.1, -0.1), { x: 0.3, y: 0.1, w: 0.3, h: 0.3 });
  assert.deepEqual(core.moveMask(base, 1, 1), { x: 0.7, y: 0.7, w: 0.3, h: 0.3 }, '拖到边界就停住');
  assert.deepEqual(core.resizeMask(base, 0.2, 0.2), { x: 0.2, y: 0.2, w: 0.5, h: 0.5 });
  assert.deepEqual(core.resizeMask(base, 5, 5), { x: 0.2, y: 0.2, w: 0.8, h: 0.8 }, '缩放不越界');
});

test('遮挡框：从左下往右上拖也能得到正向矩形', () => {
  assert.deepEqual(core.maskFromDrag(0.6, 0.6, 0.2, 0.3), { x: 0.2, y: 0.3, w: 0.4, h: 0.3 });
  const reversed = core.maskFromDrag(0.2, 0.3, 0.6, 0.6);
  assert.equal(reversed.x, 0.2);
  assert.equal(reversed.y, 0.3);
  assert.ok(Math.abs(reversed.w - 0.4) < 1e-9);
  assert.ok(Math.abs(reversed.h - 0.3) < 1e-9);
});

test('遮挡框：生成的矩形一定通过导入校验（core.issue）', () => {
  const masks = [
    core.moveMask({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, -0.5, -0.5),
    core.resizeMask({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, 0.9, 0.9),
    core.maskFromDrag(0.9, 0.9, 0.1, 0.1)
  ];
  const card = { type: 'occlusion', image: 'data:image/png;base64,AAAA', front: '看图', back: '答案', masks };
  assert.equal(core.issue(card), '', '编辑器产出的框必须是合法坐标');
});
