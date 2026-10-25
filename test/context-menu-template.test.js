'use strict'

/**
 * 右键菜单：图片场景必须能操作图片。
 *
 * ## 背景
 *
 * 2026-10-25 用户报：WhatsApp 里点开图片放大 → 右键 → **毫无反应**。
 * 截图里是标准的灯箱（大图 + 底部缩略图条）。
 *
 * 第一版修复（2026-10-23）只处理了 `mediaType === 'image'` 和 blob URL，
 * 注释里自己承认"背景图这种情况拿不到 srcURL，只能给通用项"。这就是漏掉的那一半：
 *
 *   · 灯箱用 `<div style="background-image:...">` 或 `<canvas>` 铺图时，
 *     Electron 给的是 `mediaType: 'none'` + `srcURL: ''`；
 *   · 判不出图片 → 掉进"文字/输入框"分支 → 既没选中文字也不是输入框
 *     → template 为空 → 只剩「重新加载」。
 *
 * 用户在图片上右键，看到的是跟图片毫无关系的菜单 —— 体感就是"没反应"。
 */

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const { buildContextMenuTemplate, isImageContext } =
  require('../desktop/src/window/context-menu-template')

/** 记录哪个动作被调了，用来验证 click 绑对了 */
function spyActions () {
  const called = []
  const mark = name => () => { called.push(name) }
  return {
    called,
    actions: {
      copyImage: mark('copyImage'),
      saveImage: mark('saveImage'),
      openImage: mark('openImage'),
      saveFromPage: mark('saveFromPage'),
      copyText: mark('copyText'),
      cut: mark('cut'),
      paste: mark('paste'),
      selectAll: mark('selectAll'),
      reload: mark('reload')
    }
  }
}

function labels (template) {
  return template.map(item => item.label).filter(Boolean)
}

/** 点第 n 个菜单项，返回实际触发的动作名 */
function clickItem (template, n) {
  const item = template[n]
  assert.ok(item && typeof item.click === 'function', '第 ' + n + ' 项不可点')
  item.click()
}

/* ------------------------------------------------------------------ */

test('普通 <img>：给出复制 / 另存 / 新窗口三件套', () => {
  const { actions } = spyActions()
  const t = buildContextMenuTemplate(
    { mediaType: 'image', srcURL: 'https://x.com/a.jpg' }, actions)
  assert.deepEqual(labels(t), ['复制图片', '图片另存为…', '在新窗口打开图片', '重新加载'])
})

test('★ 灯箱用 background-image（mediaType=none、srcURL 为空）也必须能存图', () => {
  // 这是用户报的那个场景：判断不出图片，但用户明明在看图。
  assert.equal(isImageContext({ mediaType: 'none', srcURL: '' }), false,
    '前提：这种 params 确实判不出是图片')

  const { called, actions } = spyActions()
  const t = buildContextMenuTemplate({ mediaType: 'none', srcURL: '' }, actions)
  const ls = labels(t)
  assert.ok(ls.includes('保存图片…'),
    '灯箱场景没有图片操作 —— 用户看到的就是"右键没反应"。实际菜单：' + JSON.stringify(ls))

  clickItem(t, ls.indexOf('保存图片…'))
  assert.deepEqual(called, ['saveFromPage'], '点了「保存图片…」却没有走到页面内嗅探')
})

test('★ 空白处右键不能是空菜单（也不能只有"重新加载"这一项）', () => {
  const { actions } = spyActions()
  const t = buildContextMenuTemplate({ mediaType: 'none', srcURL: '' }, actions)
  assert.ok(t.length > 0, '空菜单 = 用户以为卡死了')
  assert.ok(!(t.length === 1 && t[0].label === '重新加载'), '只剩"重新加载"等于没修')
})

test('canvas 上右键：同样走兜底存图', () => {
  const { actions } = spyActions()
  const t = buildContextMenuTemplate({ mediaType: 'none', srcURL: '', isEditable: false }, actions)
  assert.ok(labels(t).includes('保存图片…'))
})

test('blob: 图片（mediaType=none）算图片', () => {
  assert.equal(isImageContext({ mediaType: 'none', srcURL: 'blob:https://x/abc' }), true)
  const { actions } = spyActions()
  const t = buildContextMenuTemplate({ mediaType: 'none', srcURL: 'blob:https://x/abc' }, actions)
  assert.ok(labels(t).includes('复制图片'))
})

test('data: 图片只给"复制图片"（存下来多半是占位图）', () => {
  const { actions } = spyActions()
  const t = buildContextMenuTemplate(
    { mediaType: 'image', srcURL: 'data:image/png;base64,AAAA' }, actions)
  assert.ok(labels(t).includes('复制图片'))
  assert.ok(!labels(t).includes('图片另存为…'))
})

test('图片上不该出现"粘贴"（那是输入框的菜单项）', () => {
  const { actions } = spyActions()
  const t = buildContextMenuTemplate(
    { mediaType: 'image', srcURL: 'https://x.com/a.jpg', isEditable: true }, actions)
  assert.ok(!labels(t).includes('粘贴'))
})

test('选中文字 → 复制 + 全选', () => {
  const { called, actions } = spyActions()
  const t = buildContextMenuTemplate({ selectionText: 'hello' }, actions)
  assert.deepEqual(labels(t), ['复制', '全选'])
  clickItem(t, 0)
  assert.deepEqual(called, ['copyText'])
})

test('输入框 → 剪切 / 粘贴 / 全选', () => {
  const { actions } = spyActions()
  const t = buildContextMenuTemplate({ isEditable: true }, actions)
  assert.deepEqual(labels(t), ['剪切', '粘贴', '全选'])
})

test('每个 click 都真的调到对应动作（不能点了没反应）', () => {
  const { called, actions } = spyActions()
  const cases = [
    [{ mediaType: 'image', srcURL: 'https://x/a.jpg' }, ['copyImage', 'saveImage', 'openImage']],
    [{ mediaType: 'image', srcURL: 'data:image/png;base64,A' }, ['copyImage']],
    [{ isEditable: true }, ['cut', 'paste', 'selectAll']]
  ]
  for (const [params, expect] of cases) {
    called.length = 0
    const t = buildContextMenuTemplate(params, actions)
    // 只点前 N 个（跳过分隔符）
    let n = 0
    for (const item of t) {
      if (typeof item.click !== 'function') continue
      if (n >= expect.length) break
      item.click()
      n++
    }
    assert.deepEqual(called, expect, 'params=' + JSON.stringify(params))
  }
})

test('缺动作回调时点菜单不能崩（只静默跳过）', () => {
  const t = buildContextMenuTemplate({ mediaType: 'image', srcURL: 'https://x/a.jpg' }, {})
  for (const item of t) {
    if (typeof item.click === 'function') assert.doesNotThrow(() => item.click())
  }
})
