const pixLogin = document.getElementById('pixLogin')
const tgSetup = document.getElementById('tgSetup')
const tgLogin = document.getElementById('tgLogin')
const shell = document.getElementById('shell')
const modal = document.getElementById('modal')
const modalCard = document.getElementById('modalCard')
const dialogList = document.getElementById('dialogList')
const messageList = document.getElementById('messageList')
const threadTitle = document.getElementById('threadTitle')
const threadMeta = document.getElementById('threadMeta')
const composer = document.getElementById('composer')
const colors = ['#e17076', '#7bc862', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774']

let state = {}
let dialogs = []
let activeId = ''
let messages = []
let translations = {}

function show(el, on) {
  el.classList.toggle('hidden', !on)
}

function screen(name) {
  show(pixLogin, name === 'pix')
  show(tgSetup, name === 'setup')
  show(tgLogin, name === 'tg')
  show(shell, name === 'app')
}

function esc(text) {
  return String(text || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]))
}

function letter(title) {
  const value = String(title || '?').trim()
  return value ? value[0].toUpperCase() : '?'
}

function color(id) {
  let sum = 0
  String(id || '').split('').forEach(ch => { sum += ch.charCodeAt(0) })
  return colors[sum % colors.length]
}

function timeText(value) {
  if (!value) return ''
  const date = new Date(value)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function closeModal() {
  show(modal, false)
  modalCard.innerHTML = ''
}

function openModal(html) {
  modalCard.innerHTML = html
  show(modal, true)
}

async function boot() {
  state = await window.app.state()
  if (!state.pix) return screen('pix')
  if (!state.telegramApiReady) return screen('setup')
  if (!state.telegramAuthorized) return screen('tg')
  screen('app')
  await loadDialogs()
}

document.getElementById('pixClose').onclick = () => window.close()
document.getElementById('pixPreview').onclick = () => {
  state.pix = state.pix || { username: '预览', charBalance: 0, basename: '预览' }
  screen('app')
}
document.getElementById('pixEnter').onclick = async () => {
  const error = document.getElementById('pixError')
  error.textContent = ''
  try {
    state.pix = await window.app.pixLogin({
      username: document.getElementById('pixUser').value.trim(),
      password: document.getElementById('pixPass').value
    })
    await boot()
  } catch (err) {
    error.textContent = err.message || '登录失败'
  }
}

document.getElementById('setupSave').onclick = async () => {
  const error = document.getElementById('setupError')
  error.textContent = ''
  try {
    await window.app.saveTelegramApi({
      apiId: document.getElementById('apiId').value.trim(),
      apiHash: document.getElementById('apiHash').value.trim()
    })
    await boot()
  } catch (err) {
    error.textContent = err.message || '保存失败'
  }
}

document.getElementById('tgNext').onclick = async () => {
  const error = document.getElementById('tgError')
  const codeRow = document.getElementById('codeRow')
  const passRow = document.getElementById('passRow')
  error.textContent = ''
  try {
    if (!codeRow.classList.contains('hidden')) {
      await window.app.submitCode(document.getElementById('tgCode').value)
      return
    }
    if (!passRow.classList.contains('hidden')) {
      await window.app.submitPassword(document.getElementById('tg2fa').value)
      return
    }
    const result = await window.app.connectTelegram({ phone: document.getElementById('tgPhone').value.trim() })
    if (result && result.authorized) {
      await boot()
      return
    }
    document.getElementById('phoneRow').classList.add('hidden')
    codeRow.classList.remove('hidden')
    document.getElementById('tgNext').textContent = '确认验证码'
  } catch (err) {
    error.textContent = err.message || '连接失败'
  }
}

window.app.on('tg:needCode', () => {
  document.getElementById('phoneRow').classList.add('hidden')
  document.getElementById('codeRow').classList.remove('hidden')
  document.getElementById('tgNext').textContent = '确认验证码'
})
window.app.on('tg:needPassword', () => {
  document.getElementById('codeRow').classList.add('hidden')
  document.getElementById('passRow').classList.remove('hidden')
  document.getElementById('tgNext').textContent = '确认密码'
})
window.app.on('tg:ready', () => boot())
window.app.on('tg:error', msg => {
  document.getElementById('tgError').textContent = msg || 'Telegram 连接失败'
})
window.app.on('tg:update', async payload => {
  if (payload && payload.dialogId === activeId && payload.message) {
    messages.push(payload.message)
    await renderMessages()
  } else {
    loadDialogs()
  }
})

async function loadDialogs() {
  dialogs = await window.app.dialogs()
  const keyword = document.getElementById('chatSearch').value.trim().toLowerCase()
  dialogList.innerHTML = dialogs.filter(item => !keyword || item.title.toLowerCase().includes(keyword)).map(item => `
    <div class="dialog ${item.id === activeId ? 'active' : ''}" data-id="${esc(item.id)}">
      <div class="avatar" style="background:${color(item.id)}">${esc(letter(item.title))}</div>
      <div class="meta">
        <div class="top"><b>${esc(item.title)}</b><span class="time">${esc(timeText(item.date))}</span></div>
        <div class="sub">${esc(item.lastMessage)}${item.unread ? `<span class="unread">${item.unread}</span>` : ''}</div>
      </div>
    </div>
  `).join('') || '<p class="hint" style="padding:16px">还没有对话。登录真实 Telegram 后会在这里出现。</p>'
}

document.getElementById('chatSearch').oninput = () => loadDialogs()
dialogList.onclick = async event => {
  const row = event.target.closest('.dialog')
  if (!row) return
  activeId = row.dataset.id
  const dialog = dialogs.find(item => item.id === activeId)
  threadTitle.textContent = dialog ? dialog.title : 'Telegram'
  threadMeta.textContent = 'Telegram'
  await loadDialogs()
  messages = await window.app.messages(activeId)
  translations = {}
  await renderMessages()
}

async function paintTranslation(message) {
  if (!message.text || translations[message.id] !== undefined) return
  try {
    const result = await window.app.translate({ text: message.text, incoming: !message.out })
    translations[message.id] = result && result.text && result.text !== message.text ? result.text : ''
  } catch (_error) {
    translations[message.id] = ''
  }
}

async function renderMessages() {
  await Promise.all(messages.map(paintTranslation))
  messageList.innerHTML = messages.map(item => `
    <div class="bubble ${item.out ? 'out' : 'in'}">
      <div class="text">${esc(item.text)}</div>
      ${translations[item.id] ? `<div class="tr">[译文]${esc(translations[item.id])}</div>` : ''}
      <div class="when">${esc(timeText(item.date))}</div>
    </div>
    <div style="clear:both"></div>
  `).join('')
  messageList.scrollTop = messageList.scrollHeight
}

async function send() {
  const text = composer.value.trim()
  if (!text || !activeId) return
  composer.value = ''
  const message = await window.app.send({ id: activeId, text })
  messages.push(message)
  await renderMessages()
  loadDialogs()
}

document.getElementById('sendBtn').onclick = () => send().catch(err => {
  threadMeta.textContent = err.message || '发送失败'
})
composer.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    send().catch(err => { threadMeta.textContent = err.message || '发送失败' })
  }
})

function profileHtml() {
  const pix = state.pix || {}
  return `
    <h3>用户信息</h3>
    <label>用户名<input value="${esc(pix.username || '')}" readonly></label>
    <label>字符数<input value="${esc(pix.charBalance || 0)}" readonly></label>
    <label>模式<input value="${esc(pix.basename || '')}" readonly></label>
    <div class="row">
      <button type="button" id="doLogout">退出登录</button>
      <button type="button" class="ghost" id="doClose">关闭</button>
    </div>
  `
}

function transHtml() {
  const prefs = state.prefs || {}
  return `
    <h3>翻译设置</h3>
    <label>翻译通道
      <select id="prefEngine">
        <option value="youdao" ${prefs.engine === 'youdao' ? 'selected' : ''}>有道翻译</option>
        <option value="google" ${prefs.engine === 'google' ? 'selected' : ''}>谷歌翻译</option>
        <option value="deepl" ${prefs.engine === 'deepl' ? 'selected' : ''}>DeepL</option>
      </select>
    </label>
    <label>语言
      <select id="prefLang">
        <option value="zh" ${prefs.lang === 'zh' ? 'selected' : ''}>中文</option>
        <option value="en" ${prefs.lang === 'en' ? 'selected' : ''}>英语</option>
      </select>
    </label>
    <label><input id="prefGroup" type="checkbox" ${prefs.transGroup ? 'checked' : ''}> 群翻译</label>
    <label><input id="prefRecv" type="checkbox" ${prefs.transRecv ? 'checked' : ''}> 翻译开关（接收）</label>
    <label><input id="prefSend" type="checkbox" ${prefs.transSend ? 'checked' : ''}> 发送翻译</label>
    <div class="row">
      <button type="button" id="savePrefs">保存</button>
      <button type="button" class="ghost" id="doClose">关闭</button>
    </div>
  `
}

function multiHtml(accounts) {
  const rows = (accounts || []).map(item => `
    <div class="account-item">
      <span>${esc(item.name || item.phone || item.id)}</span>
      <button type="button" data-switch="${esc(item.id)}">切换</button>
    </div>
  `).join('') || '<p class="hint">还没有已登录的电报账号</p>'
  return `
    <h3>程序列表</h3>
    <input id="accName" placeholder="输入名称...">
    <div class="row"><button type="button" id="addAcc">添加多开</button></div>
    ${rows}
    <div class="row"><button type="button" class="ghost" id="doClose">关闭</button></div>
  `
}

document.querySelector('.rail').onclick = async event => {
  const btn = event.target.closest('.rail-btn')
  if (!btn) return
  const action = btn.dataset.rail
  document.querySelectorAll('.rail-btn').forEach(item => item.classList.toggle('active', item === btn))
  if (action === 'chats') return closeModal()
  if (action === 'profile') {
    openModal(profileHtml())
    document.getElementById('doLogout').onclick = async () => {
      await window.app.pixLogout()
      closeModal()
      screen('pix')
    }
  } else if (action === 'trans') {
    openModal(transHtml())
    document.getElementById('savePrefs').onclick = async () => {
      state.prefs = await window.app.savePrefs({
        engine: document.getElementById('prefEngine').value,
        lang: document.getElementById('prefLang').value,
        transGroup: document.getElementById('prefGroup').checked,
        transRecv: document.getElementById('prefRecv').checked,
        transSend: document.getElementById('prefSend').checked
      })
      closeModal()
    }
  } else if (action === 'multi' || action === 'add') {
    const accounts = await window.app.accounts()
    openModal(multiHtml(accounts))
    document.getElementById('addAcc').onclick = async () => {
      await window.app.addAccount()
      closeModal()
      screen('tg')
    }
    modalCard.querySelectorAll('[data-switch]').forEach(item => {
      item.onclick = async () => {
        await window.app.switchAccount(item.dataset.switch)
        closeModal()
        await boot()
      }
    })
  }
  const closeBtn = document.getElementById('doClose')
  if (closeBtn) closeBtn.onclick = closeModal
}

modal.onclick = event => {
  if (event.target === modal) closeModal()
}

boot().catch(err => {
  document.getElementById('pixError').textContent = err.message || '启动失败'
})
