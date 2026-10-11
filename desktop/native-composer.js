'use strict'

/**
 * 用 **Chromium 原生输入**替换 WhatsApp composer 的正文。
 *
 * ## 为什么必须有这个模块（0.1.19 的根因）
 *
 * 真机 0.1.18 日志（hello-pix-2026-10-08.log）：
 *
 *     expected : len=29 hash=33aaf90e  "Test translation information."
 *     actual   : len=6  hash=3a49c2d5  "测试翻译信息"
 *     writeMethod: "execCommand:insertText"   sawBeforeInput:false   sawInput:true
 *
 * `actual` **就是原文本身** —— 译文一个字符都没进去。注意 `sawBeforeInput:false`：
 * WhatsApp 的编辑器（Lexical / DraftJS 系）在**祖先捕获阶段**就拦掉了
 * `isTrusted === false` 的 `beforeinput`（`execCommand` 产生的事件不是可信事件），
 * 于是我们的写入**从未进入编辑器的输入管线**，DOM 原地不动。
 *
 * 所以：
 *   · 继续用 `innerText` / `textContent` / `innerHTML` / `replaceChildren` /
 *     `execCommand` 这些"页面内直接改 DOM"的路子，**方向就是错的** ——
 *     它们产生的事件不可信，编辑器的状态机不会认。
 *   · 唯一可靠的路子是让 **浏览器进程** 发起真实输入：由 `webContents` 执行
 *     Chromium 的编辑命令。这样产生的事件是**可信事件**，编辑器必须按正常
 *     输入处理，它自己的 state 才会真正更新。
 *
 * ## 顺序（每一步都必须走 Chromium，不许碰 DOM）
 *
 *   1. `webContents.focus()`            —— 把焦点给到这个 view
 *   2. `webContents.selectAll()`        —— Chromium `selectAll` 编辑命令
 *   3. `webContents.delete()`           —— Chromium `delete` 编辑命令（清空选区）
 *   4. `webContents.insertText(text)`   —— Chromium 原生文本输入
 *
 * 之后由调用方（guest preload）回读 DOM、做 canonical 比对；
 * 不一致就 **fail closed**（BODY_MISMATCH 保留，绝不"只要不为空就发"）。
 *
 * 本模块只做"键盘/输入"这一类动作，**不改任何 DOM、不读任何 DOM**。
 */

/** 取这个 webContents 是否还能用。 */
function usable (wc) {
  return !!(wc && typeof wc.isDestroyed === 'function' && !wc.isDestroyed() && typeof wc.insertText === 'function')
}

function safeFocus (wc) {
  try {
    if (typeof wc.isFocused === 'function' && wc.isFocused()) return true
    wc.focus()
    return typeof wc.isFocused === 'function' ? wc.isFocused() : true
  } catch (e) {
    return false
  }
}

/**
 * 第 1~3 步：聚焦 + 全选 + 清空。
 * @returns {{ok:boolean, reason?:string, focused:boolean}}
 */
function selectAllAndClear (wc) {
  if (!usable(wc)) return { ok: false, reason: 'NO_WEB_CONTENTS', focused: false }
  const focused = safeFocus(wc)
  try {
    wc.selectAll()
    wc.delete()
  } catch (e) {
    return { ok: false, reason: 'EDIT_COMMAND_FAILED:' + ((e && e.message) || e), focused: focused }
  }
  return { ok: true, focused: focused }
}

/**
 * 第 4 步：原生插入文本。
 *
 * 多行文本：直接 `insertText("a\nb")` 交给 Chromium —— Blink 的
 * `TypingCommand::InsertText` 会把 `\n` 处理成换行，与 IME 提交多行文本走同一条路。
 * 若调用方在回读后发现换行结构没对上，会再逐行插入一次（见 `insertTextLines`）。
 *
 * @returns {{ok:boolean, reason?:string, chars:number}}
 */
function insertText (wc, text) {
  if (!usable(wc)) return { ok: false, reason: 'NO_WEB_CONTENTS', chars: 0 }
  const value = String(text == null ? '' : text)
  try {
    wc.insertText(value)
  } catch (e) {
    return { ok: false, reason: 'INSERT_TEXT_FAILED:' + ((e && e.message) || e), chars: 0 }
  }
  return { ok: true, chars: value.length }
}

/**
 * 逐行插入：`insertText(行)` + `insertText('\n')` 交替。
 * 只在前一种写法回读后换行结构对不上时使用（不是主路径）。
 */
function insertTextLines (wc, text) {
  if (!usable(wc)) return { ok: false, reason: 'NO_WEB_CONTENTS', chars: 0 }
  const value = String(text == null ? '' : text)
  const lines = value.split('\n')
  try {
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) wc.insertText('\n')
      if (lines[i]) wc.insertText(lines[i])
    }
  } catch (e) {
    return { ok: false, reason: 'INSERT_TEXT_LINES_FAILED:' + ((e && e.message) || e), chars: 0 }
  }
  return { ok: true, chars: value.length, lines: lines.length }
}

/**
 * 一次性完成 1~4 步（聚焦 → 全选 → 清空 → 原生插入）。
 * 给验收脚本 / 单测用；生产链由 guest 分两步调用，好在中间回读 DOM 留证。
 */
function nativeReplaceComposer (wc, text) {
  const cleared = selectAllAndClear(wc)
  if (!cleared.ok) return { ok: false, reason: cleared.reason, cleared: cleared, inserted: null }
  const inserted = insertText(wc, text)
  if (!inserted.ok) return { ok: false, reason: inserted.reason, cleared: cleared, inserted: inserted }
  return { ok: true, cleared: cleared, inserted: inserted }
}

module.exports = { usable, selectAllAndClear, insertText, insertTextLines, nativeReplaceComposer }
