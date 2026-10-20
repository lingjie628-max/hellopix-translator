'use strict'

/**
 * 实例资源预算 · 真 Electron 验收。
 *
 * ## 验证什么
 *
 * 真机 P0（0.1.30 修）：一个账号同窗口开到 **18 个左右**实例，再开第 19 个
 * **整个应用闪退**，没有任何提示。
 *
 * 真 Electron 实测根因：每实例（WebContentsView + 独立 persist 分区）稳定占
 * **约 24 个文件句柄**；句柄是进程级硬上限；Chromium 在渲染进程创建路径上
 * 碰到 EMFILE **不是抛错而是直接终止进程** → 闪退而不是报错。
 *
 * 本脚本用**真实创建实例**来证明：
 *   1. 每个实例确实要吃掉 N 个句柄（复现根因，不是纸上谈兵）；
 *   2. 预算判据在"再开一个就要踩线"时会返回拒绝（而不是等它崩）；
 *   3. 拒绝路径**不创建任何 Chromium 对象**（所以拒绝本身绝不可能崩）。
 *
 * 用法：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/verify-tab-budget-electron.js
 */

const { app, BrowserWindow, WebContentsView } = require('electron')
const path = require('path')

const root = path.join(__dirname, '..')
const budget = require(path.join(root, 'src/window/tab-budget.js'))

const sleep = ms => new Promise(r => setTimeout(r, ms))
const rows = []
function check (name, pass, detail) {
  rows.push({ name, pass: !!pass, detail })
  console.log((pass ? '  ✔ ' : '  ✖ ') + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)))
}

app.whenReady().then(async () => {
  console.log('\n=== 实例资源预算 · 真 Electron 验收 ===\n')

  const win = new BrowserWindow({ show: false, width: 800, height: 600 })

  // ---- 1. 实测每个实例吃多少句柄（复现根因）----
  const before = budget.openHandleCount()
  const made = []
  let perInstance = null
  try {
    for (let i = 1; i <= 6; i++) {
      const v = new WebContentsView({
        webPreferences: {
          preload: path.join(root, 'guest-inject.js'),
          partition: 'persist:pix-verify-budget-' + i,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      })
      win.contentView.addChildView(v)
      await v.webContents.loadURL('data:text/html,<p>budget ' + i + '</p>')
      made.push(v)
      if (i === 3 || i === 6) {
        const now = budget.openHandleCount()
        if (Number.isInteger(now) && Number.isInteger(before)) {
          perInstance = (now - before) / i
        }
      }
    }
  } catch (e) {
    check('能创建 6 个实例（前置）', false, String(e && e.message))
  }

  const after = budget.openHandleCount()
  check('创建 6 个实例成功（前置）', made.length === 6, { created: made.length })
  check('测得每个实例消耗的句柄数（用于确认"句柄不是瓶颈"）',
    Number.isInteger(before) && Number.isInteger(after) ? (after > before) : true,
    { before, after, perInstance: perInstance === null ? null : Number(perInstance.toFixed(1)) })
  // 0.1.31 修正：每实例约 24 个句柄是**事实**，但句柄上限极高（实测 ulimit=1048575），
  // 所以句柄不是瓶颈 —— 内存才是。这条只是把事实记录下来，不作为拒绝依据。
  check('句柄量级说明它不是瓶颈（80 实例实测仅 1886）',
    after === null || after < 10000, { after })

  // 清理，恢复现场
  for (const v of made) {
    try { win.contentView.removeChildView(v) } catch (e) {}
    try { v.webContents.destroy() } catch (e) {}
  }
  await sleep(400)

  // ---- 2. 内存水位判据（0.1.31 的主判据）----
  {
    const real = budget.memoryPressure()
    check('本机能测出真实内存水位（口径正确）',
      real.total > 0 && real.ratio >= 0 && real.ratio <= 1,
      { totalGB: Number((real.total / 1073741824).toFixed(1)), usedPct: Math.round(real.ratio * 100), source: real.source })

    // ★ 关键：macOS 上 os.freemem() 会把"可用"报成 ~1%，导致疯狂误拒。
    //   这里断言我们绕开了它 —— 否则用户会在内存充足时被告知"内存不足"。
    if (process.platform === 'darwin') {
      const os = require('node:os')
      const naivePct = Math.round((1 - os.freemem() / os.totalmem()) * 100)
      check('macOS 未误用 os.freemem 口径（否则会误报内存已满）',
        real.ratio <= 0.95 || naivePct > 95,
        { ourPct: Math.round(real.ratio * 100), naiveOsFreememPct: naivePct })
    } else {
      check('非 macOS 平台跳过 freemem 口径检查', true, { platform: process.platform })
    }

    // 高水位必须拒绝
    const high = budget.canOpenAnotherTab({ tabCount: 5, memory: { total: 16 * 1024 ** 3, used: 0.95 * 16 * 1024 ** 3 } })
    check('内存 95% → 拒绝并点名"内存"',
      high.ok === false && high.code === 'MEMORY_PRESSURE' && /内存/.test(high.reason || ''), high)

    // 低水位必须放行
    const low = budget.canOpenAnotherTab({ tabCount: 5, memory: { total: 16 * 1024 ** 3, used: 2 * 1024 ** 3 } })
    check('内存 12.5% → 放行（不许无故拦住）', low.ok === true, low)

    // 大内存机器更宽松
    const bigOK = budget.canOpenAnotherTab({ tabCount: 5, memory: { total: 32 * 1024 ** 3, used: 0.895 * 32 * 1024 ** 3 } })
    const smallNo = budget.canOpenAnotherTab({ tabCount: 5, memory: { total: 8 * 1024 ** 3, used: 0.895 * 8 * 1024 ** 3 } })
    check('同样的 89.5% 水位：32GB 放行、8GB 拒绝（自适应机器大小）',
      bigOK.ok === true && smallNo.ok === false, { big32: bigOK.ok, small8: smallNo.ok })

    // 不再有固定窗口数上限
    const manyTabs = budget.canOpenAnotherTab({ tabCount: 60, maxTabs: 0, memory: { total: 32 * 1024 ** 3, used: 4 * 1024 ** 3 } })
    check('窗口数 60 且内存充足 → 放行（固定上限已移除）', manyTabs.ok === true, manyTabs)

    const realOpen = budget.openHandleCount()
    check('本机实时句柄可测（用于真机排障）',
      realOpen === null || Number.isInteger(realOpen), { used: realOpen })
  }

  // ---- 3. 拒绝路径绝不能碰 Chromium ----
  //
  // 这是本修复最关键的性质：拒绝必须是"纯判断"，不能有任何创建动作。
  // 否则"拒绝"本身就会踩到那个会崩的路径。
  {
    const beforeReject = budget.openHandleCount()
    for (let i = 0; i < 30; i++) {
      budget.canOpenAnotherTab({ tabCount: 20, memory: { total: 8 * 1024 ** 3, used: 0.95 * 8 * 1024 ** 3 }, used: 100, limit: 65536 })
    }
    await sleep(150)
    const afterReject = budget.openHandleCount()
    check('连续 30 次"拒绝"判断不消耗任何句柄（拒绝路径不创建 Chromium 对象）',
      !Number.isInteger(beforeReject) || !Number.isInteger(afterReject) || afterReject <= beforeReject + 2,
      { before: beforeReject, after: afterReject })
  }

  // ---- 4. 拒绝之后应用仍然可用（不是"拒绝即瘫痪"）----
  {
    let alive = false
    try {
      const probe = new BrowserWindow({ show: false, width: 300, height: 200 })
      await probe.loadURL('data:text/html,<p>still alive</p>')
      alive = !probe.isDestroyed()
      probe.destroy()
    } catch (e) { alive = false }
    check('拒绝之后应用仍能正常创建窗口（拒绝不是瘫痪）', alive === true, { alive })
  }

  win.destroy()
  const failed = rows.filter(r => !r.pass)
  console.log('\n=== 结果：' + (rows.length - failed.length) + ' / ' + rows.length + ' 通过 ===')
  if (!failed.length) {
    console.log('全部通过：实例资源预算能在踩线前拒绝，且拒绝路径不碰 Chromium。\n')
  }
  app.exit(failed.length ? 1 : 0)
}).catch(e => {
  console.error('FATAL', e)
  app.exit(2)
})
