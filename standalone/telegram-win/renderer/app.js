const login = document.getElementById('login')
const shell = document.getElementById('shell')
const flyout = document.getElementById('flyout')
const flyoutBody = document.getElementById('flyoutBody')
const loginBtn = document.getElementById('loginBtn')
let state = {}
let opening = false

function errorText(err) {
  return String((err && err.message) || err || '操作失败')
    .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, '')
}

function esc(text) {
  return String(text || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]))
}

function setBusy(busy, text) {
  opening = busy
  loginBtn.disabled = busy
  loginBtn.textContent = text || '进入 Hello Pix'
  document.getElementById('openOnly').disabled = busy
}

function showShell() {
  login.classList.add('hidden')
  shell.classList.remove('hidden')
  const name = (state.pix && (state.pix.username || state.pix.nickname)) || 'P'
  document.getElementById('railAvatar').textContent = String(name).slice(0, 1).toUpperCase()
  setBusy(false)
}

function showLogin() {
  shell.classList.add('hidden')
  login.classList.remove('hidden')
  closeFlyout()
  setBusy(false)
}

async function closeFlyout() {
  flyout.classList.add('hidden')
  flyoutBody.innerHTML = ''
  document.querySelectorAll('.rail-btn').forEach(item => {
    item.classList.toggle('active', item.dataset.rail === 'chats')
  })
  await window.app.flyout(false)
}

async function openFlyout(html) {
  flyoutBody.innerHTML = html
  flyout.classList.remove('hidden')
  await window.app.flyout(true)
}

async function openTelegram(id) {
  document.getElementById('loginError').textContent = ''
  setBusy(true, '正在打开官方电报…')
  try {
    await window.app.openTelegram(id || 'main')
    setTimeout(() => {
      if (!shell.classList.contains('hidden')) return
      if (opening) {
        setBusy(false)
        document.getElementById('loginError').textContent = '电报窗口还没出现，可再点一次，或先确认 Telegram 已启动'
      }
    }, 18000)
  } catch (err) {
    setBusy(false)
    document.getElementById('loginError').textContent = errorText(err)
  }
}

async function boot() {
  state = await window.app.state()
  document.getElementById('server').value = state.apiBase || 'http://127.0.0.1:8080'
  document.getElementById('username').value = state.lastUsername || ''
  if (state.pix) await openTelegram('main')
}

document.getElementById('closeBtn').onclick = () => window.close()
loginBtn.onclick = async () => {
  const error = document.getElementById('loginError')
  error.textContent = ''
  setBusy(true, '登录中…')
  try {
    state.pix = await window.app.login({
      username: document.getElementById('username').value.trim(),
      password: document.getElementById('password').value,
      server: document.getElementById('server').value.trim()
    })
    await openTelegram('main')
  } catch (err) {
    setBusy(false)
    error.textContent = errorText(err)
  }
}

document.getElementById('openOnly').onclick = () => openTelegram('main')

function profileHtml() {
  const pix = state.pix || {}
  return `
    <h3>用户信息</h3>
    <div class="kv"><span>用户名</span><b>${esc(pix.username || pix.nickname || '-')}</b></div>
    <div class="kv"><span>字符数</span><b>${esc(pix.charBalance || 0)}</b></div>
    <div class="kv"><span>套餐</span><b>${esc(pix.basename || '-')}</b></div>
    <p class="hint">这些数据来自 Hello Pix 账号，不是 Telegram 官方账号。</p>
    <div class="row">
      <button type="button" id="doLogout" class="ghost">退出登录</button>
      <button type="button" id="doClose" class="primary">关闭</button>
    </div>
  `
}

function transHtml() {
  const prefs = state.prefs || {}
  const engines = state.engines || { known: false, wired: false, rows: [] }
  const rows = engines.rows || []
  // 通道列表来自后台 /apis/translate/engines，只有 wired（后台已配好凭据）的才列出来。
  // 以前这里写死 youdao/google/deepl，而这三个通道在后台都没接通，
  // 桥接文件写进去后魔改电报每次翻译都撞 503，气泡永远不出 [译文]。
  const picker = rows.length
    ? `<select id="prefEngine">${rows.map(row => (
        `<option value="${esc(row.id)}" ${String(prefs.engine) === String(row.id) ? 'selected' : ''}>${esc(row.name)}</option>`
      )).join('')}</select>`
    : `<select id="prefEngine" disabled><option>${engines.known ? '套餐内没有已接通的通道' : '还没取到通道列表'}</option></select>`
  const engineHint = rows.length
    ? ''
    : `<p class="hint">${engines.known
        ? '这个账号的套餐里没有已接通的翻译通道，气泡不会出现 [译文]。请到后台「翻译通道」页填好厂商凭据并设为使用中。'
        : '还没连上 Hello Pix 后台，取不到可用通道。气泡译文需要后台在运行。'}</p>`
  return `
    <h3>翻译设置</h3>
    <div class="field">
      <label>翻译通道</label>
      ${picker}
    </div>
    ${engineHint}
    <div class="field">
      <label>语言</label>
      <select id="prefLang">
        <option value="zh" ${prefs.lang === 'zh' ? 'selected' : ''}>中文</option>
        <option value="en" ${prefs.lang === 'en' ? 'selected' : ''}>英语</option>
      </select>
    </div>
    <label class="check"><input id="prefGroup" type="checkbox" ${prefs.transGroup !== false ? 'checked' : ''}> 群翻译</label>
    <label class="check"><input id="prefRecv" type="checkbox" ${prefs.transRecv !== false ? 'checked' : ''}> 接收翻译</label>
    <label class="check"><input id="prefSend" type="checkbox" ${prefs.transSend !== false ? 'checked' : ''}> 发送翻译</label>
    <textarea id="transIn" class="tr-box" placeholder="粘贴电报消息，点翻译"></textarea>
    <div id="transOut" class="tr-box">[译文] 翻译结果会显示在这里。气泡内嵌由魔改版 Telegram.exe 提供。</div>
    <p id="transErr" class="error"></p>
    <div class="row">
      <button type="button" id="doTrans" class="action">翻译</button>
      <button type="button" id="savePrefs" class="primary">保存</button>
    </div>
  `
}

function multiHtml(title, accounts) {
  const rows = (accounts || []).map(item => (
    `<div class="item"><span>${esc(item.name)}</span><button type="button" class="action" data-open="${esc(item.id)}">打开</button></div>`
  )).join('')
  return `
    <h3>${esc(title)}</h3>
    <p class="hint">每个名称会启动一份独立的官方 Telegram，数据互不影响。</p>
    ${rows}
    <div class="field"><label>输入名称</label><input id="accName" placeholder="例如 客服号"></div>
    <div class="row">
      <button type="button" id="addAcc" class="primary">添加多开</button>
      <button type="button" id="doClose" class="ghost">关闭</button>
    </div>
  `
}

function bindFlyout(kind) {
  const closeBtn = document.getElementById('doClose')
  if (closeBtn) closeBtn.onclick = () => closeFlyout()
  const logoutBtn = document.getElementById('doLogout')
  if (logoutBtn) {
    logoutBtn.onclick = async () => {
      await window.app.logout()
      showLogin()
    }
  }
  const saveBtn = document.getElementById('savePrefs')
  if (saveBtn) {
    saveBtn.onclick = async () => {
      // 通道下拉在没有已接通通道时是 disabled 的，此时不能把占位文案当成 engine 存下去。
      const engineEl = document.getElementById('prefEngine')
      state.prefs = await window.app.savePrefs({
        engine: engineEl && !engineEl.disabled ? engineEl.value : (state.prefs || {}).engine || '',
        lang: document.getElementById('prefLang').value,
        transGroup: document.getElementById('prefGroup').checked,
        transRecv: document.getElementById('prefRecv').checked,
        transSend: document.getElementById('prefSend').checked
      })
      const err = document.getElementById('transErr')
      err.textContent = state.prefs.engine
        ? '已保存，并已写入各电报实例的数据目录。'
        : '已保存，但当前没有已接通的翻译通道，气泡不会出现 [译文]。'
    }
  }
  const transBtn = document.getElementById('doTrans')
  if (transBtn) {
    transBtn.onclick = async () => {
      const err = document.getElementById('transErr')
      err.textContent = ''
      try {
        const result = await window.app.translate({
          text: document.getElementById('transIn').value,
          incoming: true
        })
        document.getElementById('transOut').textContent = result && result.text
          ? '[译文] ' + result.text
          : '[译文] 没有可显示的译文'
      } catch (error) {
        err.textContent = errorText(error)
      }
    }
  }
  const addBtn = document.getElementById('addAcc')
  if (addBtn) {
    addBtn.onclick = async () => {
      await window.app.addInstance(document.getElementById('accName').value)
      await showKind(kind)
    }
  }
  flyoutBody.querySelectorAll('[data-open]').forEach(btn => {
    btn.onclick = async () => {
      await window.app.openTelegram(btn.dataset.open)
    }
  })
}

async function showKind(kind) {
  state = await window.app.state()
  if (kind === 'trans') {
    // 每次打开都重新拉通道列表，后台刚接通的通道不用重启就能选到；
    // 拉完再取一次 state，因为主进程可能刚把 engine 重新解析成已接通的通道。
    try {
      await window.app.engines()
      state = await window.app.state()
    } catch (_error) {}
  }
  if (kind === 'profile') await openFlyout(profileHtml())
  if (kind === 'trans') await openFlyout(transHtml())
  if (kind === 'multi' || kind === 'add') {
    await openFlyout(multiHtml(kind === 'add' ? '添加账号' : '程序多开', state.instances))
  }
  bindFlyout(kind)
}

document.querySelector('.rail').onclick = async event => {
  const btn = event.target.closest('.rail-btn')
  if (!btn) return
  document.querySelectorAll('.rail-btn').forEach(item => item.classList.toggle('active', item === btn))
  const action = btn.dataset.rail
  if (action === 'chats') {
    await closeFlyout()
    await window.app.focusTelegram()
    return
  }
  await showKind(action)
}

window.app.on('app:shell', data => {
  state = data || state
  showShell()
})
window.app.on('tg:gone', () => {})

boot()
