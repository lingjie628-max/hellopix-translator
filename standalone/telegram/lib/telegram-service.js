'use strict'

const { TelegramClient } = require('telegram')
const { StringSession } = require('telegram/sessions')
const { NewMessage } = require('telegram/events')

function waiter() {
  let resolve
  const promise = new Promise(next => { resolve = next })
  return { promise, resolve }
}

function dialogId(dialog) {
  return String(dialog.id || (dialog.entity && dialog.entity.id) || '')
}

function titleOf(dialog) {
  const entity = dialog.entity || {}
  return dialog.title || entity.title || [entity.firstName, entity.lastName].filter(Boolean).join(' ') || entity.username || '对话'
}

function lastText(dialog) {
  const message = dialog.message
  if (!message) return ''
  if (message.message) return String(message.message)
  if (message.media) return '[媒体]'
  return ''
}

class TelegramService {
  constructor(store, emit) {
    this.store = store
    this.emit = emit || (() => {})
    this.client = null
    this.entities = new Map()
    this.startPromise = null
    this.codeWait = null
    this.passwordWait = null
  }

  config() {
    const data = this.store.read()
    return data.telegram || { apiId: '', apiHash: '', accounts: [], activeId: '' }
  }

  saveConfig(patch) {
    const data = this.store.read()
    data.telegram = Object.assign(this.config(), patch)
    this.store.write(data)
    return data.telegram
  }

  activeAccount() {
    const cfg = this.config()
    return (cfg.accounts || []).find(item => item.id === cfg.activeId) || cfg.accounts[0] || null
  }

  apiCredentials() {
    const cfg = this.config()
    const apiId = Number(process.env.PIX_TG_API_ID || cfg.apiId || 0)
    const apiHash = String(process.env.PIX_TG_API_HASH || cfg.apiHash || '').trim()
    return { apiId, apiHash }
  }

  async ensureClient(sessionString) {
    const { apiId, apiHash } = this.apiCredentials()
    if (!apiId || !apiHash) throw new Error('请先填写 Telegram api_id / api_hash')
    if (this.client) return this.client
    this.client = new TelegramClient(new StringSession(sessionString || ''), apiId, apiHash, {
      connectionRetries: 3,
      deviceModel: 'Hello Pix Telegram',
      appVersion: '0.1.0',
      systemVersion: process.platform
    })
    return this.client
  }

  async restore() {
    const account = this.activeAccount()
    if (!account || !account.session) return { authorized: false }
    const client = await this.ensureClient(account.session)
    await client.connect()
    const authorized = await client.checkAuthorization()
    if (authorized) this.bindUpdates()
    return { authorized, account }
  }

  bindUpdates() {
    if (!this.client || this.client.__pixBound) return
    this.client.__pixBound = true
    this.client.addEventHandler(event => {
      const message = event.message
      if (!message) return
      this.emit('tg:update', {
        dialogId: String(message.chatId || ''),
        message: this.publicMessage(message)
      })
    }, new NewMessage({}))
  }

  publicMessage(message) {
    return {
      id: String(message.id),
      out: !!message.out,
      text: String(message.message || ''),
      date: message.date ? new Date(message.date * 1000).toISOString() : new Date().toISOString(),
      sender: message.postAuthor || ''
    }
  }

  publicDialog(dialog) {
    const id = dialogId(dialog)
    if (dialog.entity) this.entities.set(id, dialog.entity)
    return {
      id,
      title: titleOf(dialog),
      unread: Number(dialog.unreadCount || 0),
      lastMessage: lastText(dialog),
      date: dialog.date ? new Date(dialog.date * 1000).toISOString() : '',
      pinned: !!dialog.pinned
    }
  }

  async connect(phone) {
    const { apiId, apiHash } = this.apiCredentials()
    if (!apiId || !apiHash) throw new Error('请先到 my.telegram.org 申请 api_id / api_hash')
    const number = String(phone || '').replace(/\s+/g, '')
    if (!/^\+\d{6,20}$/.test(number)) throw new Error('请填写含国家码的手机号，例如 +8613812345678')
    const account = this.activeAccount()
    const client = await this.ensureClient(account && account.session)
    await client.connect()
    if (await client.checkAuthorization()) {
      this.bindUpdates()
      return { authorized: true }
    }
    if (!this.startPromise) {
      this.startPromise = client.start({
        phoneNumber: async () => number,
        phoneCode: async () => {
          this.emit('tg:needCode')
          this.codeWait = waiter()
          return this.codeWait.promise
        },
        password: async () => {
          this.emit('tg:needPassword')
          this.passwordWait = waiter()
          return this.passwordWait.promise
        },
        onError: error => {
          this.emit('tg:error', error && error.message ? error.message : String(error))
          return false
        }
      }).then(async () => {
        const session = client.session.save()
        const me = await client.getMe()
        const id = String(me.id)
        const name = [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || number
        const cfg = this.config()
        const accounts = cfg.accounts.filter(item => item.id !== id)
        accounts.push({ id, name, phone: number, session })
        this.saveConfig({ accounts, activeId: id })
        this.bindUpdates()
        this.emit('tg:ready', { id, name })
        return { authorized: true }
      }).finally(() => {
        this.startPromise = null
      })
    }
    return { authorized: false, waiting: 'code' }
  }

  submitCode(code) {
    const value = String(code || '').trim()
    if (!value) throw new Error('请输入验证码')
    if (!this.codeWait) throw new Error('当前不在验证码步骤')
    this.codeWait.resolve(value)
    this.codeWait = null
    return { ok: true }
  }

  submitPassword(password) {
    const value = String(password || '')
    if (!value) throw new Error('请输入两步验证密码')
    if (!this.passwordWait) throw new Error('当前不在两步验证步骤')
    this.passwordWait.resolve(value)
    this.passwordWait = null
    return { ok: true }
  }

  async dialogs() {
    if (!this.client || !(await this.client.checkAuthorization())) return []
    const rows = await this.client.getDialogs({ limit: 80 })
    return rows.map(dialog => this.publicDialog(dialog))
  }

  async messages(id) {
    const entity = this.entities.get(String(id))
    if (!this.client || !entity) return []
    const rows = await this.client.getMessages(entity, { limit: 40 })
    return rows.slice().reverse().map(message => this.publicMessage(message))
  }

  async send(id, text) {
    const entity = this.entities.get(String(id))
    const value = String(text || '').trim()
    if (!entity) throw new Error('对话不存在')
    if (!value) throw new Error('请输入消息')
    const message = await this.client.sendMessage(entity, { message: value })
    return this.publicMessage(message)
  }

  async addAccount() {
    if (this.client) {
      try { await this.client.disconnect() } catch (_error) {}
    }
    this.client = null
    this.entities.clear()
    this.saveConfig({ activeId: '' })
    return { authorized: false }
  }

  async switchAccount(id) {
    const cfg = this.config()
    const account = (cfg.accounts || []).find(item => item.id === String(id))
    if (!account) throw new Error('账号不存在')
    if (this.client) {
      try { await this.client.disconnect() } catch (_error) {}
    }
    this.client = null
    this.entities.clear()
    this.saveConfig({ activeId: account.id })
    return this.restore()
  }
}

module.exports = { TelegramService }
