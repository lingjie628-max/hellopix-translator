'use strict'

/**
 * 视图几何与布局计划。
 *
 * 这里锁的是"算错了不报错、只表现为画面错位"的一类问题：
 * 底部被截掉一条、页面被挡住、隐藏的窗口又冒出来。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  viewBounds,
  planLayout,
  chromeOffset,
  easeOutCubic
} = require('../desktop/src/window/view-layout')

// ---------------------------------------------------------------------------
// 几何
// ---------------------------------------------------------------------------

test('viewBounds：必须扣掉顶部 chrome 和底部状态栏', () => {
  const b = viewBounds({ y: 100, width: 1280, height: 800, footerHeight: 30 })
  assert.deepEqual(b, { x: 0, y: 100, width: 1280, height: 670 })
  assert.equal(b.height, 800 - 100 - 30, '底部状态栏是窗口 chrome，不属于实例视图')
})

test('viewBounds：y 取整且不为负', () => {
  assert.equal(viewBounds({ y: -5, width: 100, height: 100, footerHeight: 0 }).y, 0)
  assert.equal(viewBounds({ y: 10.6, width: 100, height: 100, footerHeight: 0 }).y, 11,
    'setBounds 只接受整数，不取整会出现半像素抖动')
})

test('viewBounds：极端值不会算出负高度', () => {
  const b = viewBounds({ y: 900, width: 1280, height: 800, footerHeight: 30 })
  assert.equal(b.height, 0, '高度不能是负数，否则 Electron 会抛错')
  const c = viewBounds({ y: 0, width: -100, height: -100, footerHeight: 30 })
  assert.equal(c.width, 0)
  assert.equal(c.height, 0)
  // 空参数不崩
  assert.deepEqual(viewBounds({}), { x: 0, y: 0, width: 0, height: 0 })
})

// ---------------------------------------------------------------------------
// 布局计划
// ---------------------------------------------------------------------------

test('planLayout：首页 / 遮罩 / 无实例 → 全部摘掉', () => {
  const tabs = [{ id: 'a', view: {} }]
  assert.equal(planLayout({ tabs, activeId: 'a', showHome: true }).detachAll, true)
  assert.equal(planLayout({ tabs, activeId: 'a', overlayOpen: true }).detachAll, true)
  assert.equal(planLayout({ tabs: [], activeId: '' }).detachAll, true)
  // 全是已销毁的（view 被置空）
  assert.equal(planLayout({ tabs: [{ id: 'a', view: null }], activeId: 'a' }).detachAll, true)
})

test('planLayout：正常态下只有激活实例被挂上，其余全部摘掉', () => {
  const tabs = [{ id: 'a', view: {} }, { id: 'b', view: {} }, { id: 'c', view: {} }]
  const plan = planLayout({ tabs, activeId: 'b' })
  assert.equal(plan.detachAll, false)
  assert.equal(plan.active.id, 'b')
  assert.deepEqual(plan.detach.map(t => t.id), ['a', 'c'])
})

test('planLayout：隐藏的实例绝不能被选中，也绝不能被挂回视图树', () => {
  const tabs = [
    { id: 'a', view: {}, hidden: true },
    { id: 'b', view: {} }
  ]
  // activeId 指向一个隐藏实例：不能把它挂上去，否则会盖住正常画面
  const plan = planLayout({ tabs, activeId: 'a' })
  assert.equal(plan.active, null, '隐藏的实例不能成为激活视图')
  assert.deepEqual(plan.detach.map(t => t.id), ['a', 'b'], '两个都要摘掉')
})

test('planLayout：容忍 tab.view 为 null（关闭与重排是同一轮里的连续动作）', () => {
  const tabs = [{ id: 'a', view: {} }, { id: 'b', view: null }, { id: 'c', view: {} }]
  const plan = planLayout({ tabs, activeId: 'a' })
  assert.equal(plan.active.id, 'a')
  assert.deepEqual(plan.detach.map(t => t.id), ['c'], '已销毁的 tab 不该出现在 detach 名单里')
})

test('planLayout：activeId 找不到 → 没有任何视图被挂上', () => {
  const tabs = [{ id: 'a', view: {} }]
  const plan = planLayout({ tabs, activeId: 'nope' })
  assert.equal(plan.active, null)
  assert.deepEqual(plan.detach.map(t => t.id), ['a'])
})

test('planLayout：空参数不崩', () => {
  assert.equal(planLayout(null).detachAll, true)
  assert.equal(planLayout({}).detachAll, true)
})

// ---------------------------------------------------------------------------
// chrome 偏移
// ---------------------------------------------------------------------------

test('chromeOffset：有哨兵实测值时直接用，不再按常量估', () => {
  const y = chromeOffset({
    hasMeasuredChrome: true,
    measuredChromeHeight: 137,
    wantsTransBar: true,
    sizes: { tabs: 34, utility: 40, transBar: 78, status: 22 }
  })
  assert.equal(y, 137, '哨兵值是唯一真相：样式改了也不用改代码')
})

test('chromeOffset：首帧按常量估算，翻译栏可选', () => {
  const sizes = { tabs: 34, utility: 40, transBar: 78, status: 22 }
  assert.equal(chromeOffset({ sizes }), 34 + 40, '没有翻译栏也没有状态栏')
  assert.equal(chromeOffset({ wantsTransBar: true, sizes }), 34 + 40 + 78)
  assert.equal(chromeOffset({ wantsStatus: true, sizes }), 34 + 40 + 22)
  assert.equal(chromeOffset({ wantsTransBar: true, wantsStatus: true, sizes }), 34 + 40 + 78 + 22)
})

test('chromeOffset：翻译栏高度优先用实测值（CSS 实测约 88px，与常量不一致）', () => {
  const sizes = { tabs: 34, utility: 40, transBar: 78, status: 22 }
  const y = chromeOffset({
    wantsTransBar: true,
    hasMeasuredBarHeight: true,
    measuredTransBarHeight: 88,
    sizes
  })
  assert.equal(y, 34 + 40 + 88, '常量是估的，实测值才是真的')
})

// ---------------------------------------------------------------------------
// 缓动
// ---------------------------------------------------------------------------

test('easeOutCubic：端点精确，单调递增', () => {
  assert.equal(easeOutCubic(0), 0)
  assert.equal(easeOutCubic(1), 1)
  let prev = -1
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const v = easeOutCubic(Math.min(1, t))
    assert.ok(v >= prev - 1e-9, '必须单调，否则动画会抖')
    prev = v
  }
})
