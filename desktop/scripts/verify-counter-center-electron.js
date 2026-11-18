'use strict'

/**
 * 原生进粉中心真实渲染验收。
 *
 * 用真实 Electron 加载 renderer/index.html，注入一份只读假数据，打开
 * 进粉中心并截图深色 / 浅色 / 窄窗三种状态。它验证的是脚本装载、原生视图
 * 让位、主题适配、窄窗布局和数据渲染，不接触真实账号或生产数据库。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const DESKTOP = process.env.PIX_COUNTER_DESKTOP || path.join(__dirname, '..')
const ELECTRON_BIN = path.join(DESKTOP, 'node_modules', 'electron', 'dist',
  'Electron.app', 'Contents', 'MacOS', 'Electron')

if (!process.versions.electron) {
  if (!fs.existsSync(ELECTRON_BIN)) {
    console.error('找不到 Electron 二进制：' + ELECTRON_BIN)
    process.exit(2)
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-counter-verify-'))
  fs.copyFileSync(__filename, path.join(root, 'verify.js'))
  fs.writeFileSync(path.join(root, 'package.json'),
    JSON.stringify({ name: 'pix-counter-verify', main: 'verify.js' }))
  fs.symlinkSync(path.join(DESKTOP, 'node_modules'), path.join(root, 'node_modules'))
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  env.PIX_COUNTER_DESKTOP = DESKTOP
  const result = spawnSync(ELECTRON_BIN, [root], { encoding: 'utf8', env })
  process.stdout.write((result.stdout || '') + (result.stderr || ''))
  try { fs.rmSync(root, { recursive: true, force: true }) } catch (e) {}
  process.exit(result.status == null ? 1 : result.status)
}

const { app, BrowserWindow } = require('electron')

app.disableHardwareAcceleration()

const fixture = `
(() => {
  const rows = [{
    id: 9,
    code: 'IT-20261116-9',
    title: '新粉跟进 · Ana',
    customer_public_id: 'C_101',
    status: 'open',
    priority: 'normal',
    fan_kind: 'new'
  }, {
    id: 10,
    code: 'IT-20261116-10',
    title: '重粉跟进 · Bruno',
    customer_public_id: 'C_102',
    status: 'in_progress',
    priority: 'high',
    fan_kind: 'repeat'
  }]
  const counter = {
    summary: async () => ({ new: 18, repeat: 7, total: 25, unique: 23 }),
    events: async () => ({ rows: [{
      id: 1,
      kind: 'new',
      customer_public_id: 'C_101',
      account_label: '巴西一号',
      push_name: 'Ana',
      phone_tail: '7471',
      first_msg_at: new Date().toISOString(),
      ticket_id: 9,
      ticket_code: 'IT-20261116-9'
    }, {
      id: 2,
      kind: 'repeat',
      customer_public_id: 'C_102',
      account_label: '墨西哥二号',
      push_name: 'Bruno',
      phone_tail: '1177',
      first_msg_at: new Date(Date.now() - 60000).toISOString(),
      ticket_id: 10,
      ticket_code: 'IT-20261116-10'
    }] }),
    repeats: async () => ({ rows: [] }),
    accounts: async () => ([{
      id: 91,
      local_tab_id: '1:whatsapp-green-1',
      label: '巴西一号',
      new_fans: 18,
      repeat_fans: 7,
      total_fans: 25,
      archived_at: null
    }]),
    tabs: async () => ([{
      id: 'whatsapp-green-1',
      platform: 'whatsapp-green',
      name: '巴西一号',
      enableCounter: true,
      hidden: false,
      localTabId: '1:whatsapp-green-1'
    }]),
    tickets: async () => ({ rows }),
    ticket: async () => ({
      ticket: Object.assign({}, rows[0], {
        account_label: '巴西一号',
        first_msg_at: new Date().toISOString(),
        due_at: new Date(Date.now() + 3600000).toISOString()
      }),
      events: [{ kind: 'create', body: '已创建自动进粉工单', created_at: new Date().toISOString() }]
    }),
    transitionTicket: async () => ({ success: true }),
    replyTicket: async () => ({ success: true }),
    toggleTab: async () => ({ success: true }),
    queueStatus: async () => ({ pending: 0, failed: 0, lastError: '' }),
    retryFailed: async () => ({ success: true }),
    flush: async () => ({ success: true }),
    onUpdated: () => {}
  }
  window.pix = Object.assign(window.pix || {}, {
    counter,
    setOverlay: () => {},
    onTabs: () => {},
    home: () => {},
    switchTab: () => {}
  })
})()
`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 820,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  const failures = []
  try {
    await win.loadFile(path.join(DESKTOP, 'renderer', 'index.html'))
    await win.webContents.executeJavaScript(fixture)
    await win.webContents.executeJavaScript(`document.getElementById('counterBtn').click()`)
    await new Promise(resolve => setTimeout(resolve, 450))

    async function inspect(theme, width, height, file) {
      win.setSize(width, height)
      await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      await new Promise(resolve => setTimeout(resolve, 180))
      const report = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({
        theme: document.documentElement.dataset.theme,
        visible: !document.getElementById('counterCenter').classList.contains('hidden'),
        kpis: document.querySelectorAll('.counter-kpi').length,
        rows: document.querySelectorAll('.counter-table tbody tr').length,
        text: document.getElementById('counterCenterBody').innerText.slice(0, 220),
        viewport: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        cardWidth: document.querySelector('.counter-center-card').getBoundingClientRect().width
      })`))
      const image = await win.webContents.capturePage()
      fs.writeFileSync(file, image.toPNG())
      if (!report.visible) failures.push(theme + ': 面板未打开')
      if (report.kpis !== 4) failures.push(theme + ': KPI 数量=' + report.kpis)
      if (report.rows < 2) failures.push(theme + ': 流水行数=' + report.rows)
      if (!/新粉/.test(report.text) || !/重粉/.test(report.text)) failures.push(theme + ': 数据文案缺失')
      if (report.documentWidth > report.viewport) failures.push(theme + ': 页面横向溢出')
      if (report.cardWidth > report.viewport) failures.push(theme + ': 面板宽于视口')
      return report
    }

    const dark = await inspect('dark', 1280, 820, '/tmp/hello-pix-counter-dark.png')
    const light = await inspect('light', 1180, 760, '/tmp/hello-pix-counter-light.png')
    const narrow = await inspect('dark', 820, 700, '/tmp/hello-pix-counter-narrow.png')
    if (failures.length) {
      console.log('VERIFY_COUNTER_FAIL=' + JSON.stringify(failures, null, 2))
      app.exit(1)
      return
    }
    console.log('VERIFY_COUNTER_OK=' + JSON.stringify({
      dark,
      light,
      narrow,
      screenshots: [
        '/tmp/hello-pix-counter-dark.png',
        '/tmp/hello-pix-counter-light.png',
        '/tmp/hello-pix-counter-narrow.png'
      ]
    }))
    app.exit(0)
  } catch (error) {
    console.log('VERIFY_COUNTER_FAIL=' + ((error && error.stack) || error))
    app.exit(1)
  }
})
