import axios from 'axios'
import Vue from 'vue'
import { Message, MessageBox } from 'element-ui'
import router from '../router'
import store from '../store'
import { encodeForm } from './encode-form'

axios.defaults.baseURL = '/apis'
axios.defaults.withCredentials = true
axios.defaults.timeout = 30000

function cookieValue(names) {
  const cookies = {}
  document.cookie.split(';').forEach(part => {
    const index = part.indexOf('=')
    if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  })
  for (const name of names) {
    if (cookies[name]) return cookies[name]
  }
  return ''
}

axios.interceptors.request.use(config => {
  const method = String(config.method || 'get').toLowerCase()
  if (!['get', 'head', 'options'].includes(method)) {
    const token = cookieValue(['__Host-pix_csrf', 'pix_csrf'])
    if (token) config.headers['X-CSRF-Token'] = token
  }
  // 高危操作（建超管、改商户密码、读客户名单）要求二次认证。
  // 密码验证过一次之后存在内存里，本次会话内继续用 —— 不落 cookie/localStorage，
  // 刷新页面即失效，避免密码长期躺在浏览器里。
  if (reauthToken && String(config.url || '').indexOf('/admin/') === 0) {
    config.headers['x-pix-reauth'] = reauthToken
  }
  return config
})

/**
 * 二次认证（高危操作）用的密码缓存。
 *
 * 只存在模块内存里，刻意**不持久化**：刷新页面就得重新输。
 * 会话被偷的场景下，攻击者拿到 cookie 也没用 —— 他没有密码。
 */
let reauthToken = ''

/**
 * 管理端需要二次认证时弹的密码框（Promise 化）。
 *
 * Element UI 的 MessageBox 只接受 **VNode**（见其 main.js 里 isVNode 判断），
 * 不接受渲染函数。所以这里用 Vue 构造器的 $createElement 造 VNode ——
 * 顺带也绕开了 `dangerouslyUseHTMLString`（拼 HTML 属于没必要的 XSS 面）。
 */
function askReauthPassword () {
  return new Promise(resolve => {
    const createElement = Vue.prototype.$createElement
    const vnode = createElement('div', null, [
      createElement('p', null, '该操作属于高危操作，请输入当前管理员密码确认是你本人。'),
      createElement('input', {
        attrs: {
          type: 'password',
          id: 'pix-reauth-input',
          placeholder: '当前管理员密码',
          autocomplete: 'current-password'
        },
        style: 'margin-top:12px;width:100%;box-sizing:border-box;padding:0 12px;height:38px;'
      })
    ])
    MessageBox({
      title: '需要重新验证身份',
      message: vnode,
      showCancelButton: true,
      confirmButtonText: '确认',
      cancelButtonText: '取消',
      beforeClose: (action, instance, done) => {
        if (action !== 'confirm') { done(); resolve(''); return }
        const el = document.getElementById('pix-reauth-input')
        const value = el ? el.value : ''
        if (!value) { Message.warning('请输入密码'); return }
        done()
        resolve(value)
      }
    })
  })
}

/**
 * 428 = 高危操作需要二次认证。
 *
 * 处理方式：弹框要密码 → 带 x-pix-reauth 重放原请求。
 * 这样后台页面**一行都不用改** —— 各个管理页照常调 postRequest，
 * 只是第一次点"建超管"会多一个密码确认框。
 */
axios.interceptors.response.use(
  success => success,
  async error => {
    const status = error.response && error.response.status
    const config = error.config || {}
    // 只自动重试一次，且只针对 428
    if (status === 428 && !config.__reauthRetried) {
      const password = await askReauthPassword()
      if (!password) {
        Message.info('已取消该操作')
        return Promise.reject(error)
      }
      reauthToken = password
      config.__reauthRetried = true
      config.headers = Object.assign({}, config.headers, { 'x-pix-reauth': password })
      try {
        return await axios(config)
      } catch (retryError) {
        // 密码错了：清掉缓存，让下次重新问
        reauthToken = ''
        return Promise.reject(retryError)
      }
    }
    // 重试后仍然 428/401(REAUTH_FAILED)：清缓存，提示需要重新输
    if (status === 401 && error.response && error.response.data &&
        error.response.data.code === 'REAUTH_FAILED') {
      reauthToken = ''
    }
    return handleError(error)
  }
)

function handleError (error) {
  const status = error.response && error.response.status
  // 后端给的 msg 优先于按状态码写死的文案。
  // 403 至少有两种成因：真的越权（该操作仅限超级管理员）、以及 CSRF 校验失败
  // （后端会提示"请刷新页面后重试"）。此前 403 一律显示"权限不足，请联系管理员"，
  // 把后者真正有用的指引吞掉了 —— 用户以为是权限问题，其实刷新页面就好。
  const serverMsg = error.response && error.response.data && error.response.data.msg
  // 请求可以带 `silent: true` 关掉这里的自动提示，由调用方自己处理错误。
  // 用于需要按错误码做不同动作的场景（如注册页收到 CAPTCHA_EXPIRED 要
  // 自动换一张验证码图），否则会和调用方自己弹的提示叠成两条。
  const silent = !!(error.config && error.config.silent)
  const notify = message => { if (!silent) Message.error({ message }) }
  if (status === 429) {
    notify(serverMsg || '请求过于频繁，请稍后再试')
  } else if (status === 504 || status === 404) {
    notify(serverMsg || '服务器连接失败')
  } else if (status === 403) {
    notify(serverMsg || '权限不足，请联系管理员')
  } else if (status === 401) {
    // 401 有两种完全不同的含义，不能一视同仁：
    //   1) 登录接口返回 401 = 账号或密码错误（后端文案就是"超管账号或密码错误"）；
    //   2) 其它接口返回 401 = 会话已过期。
    // 之前不区分，用户在登录页输错密码时看到的是"超管尚未登录"，
    // 还被"跳转"到当前所在的登录页（原地打转），真正有用的提示被吞掉。
    const url = String((error.config && error.config.url) || '')
    const isLoginAttempt = /\/(?:admin\/)?login(\/totp)?$/.test(url)
    if (isLoginAttempt) {
      notify(serverMsg || '账号或密码错误')
      return Promise.reject(error)
    }
    const onAdmin = router.currentRoute.path.indexOf('/admin') === 0
    notify(serverMsg || '登录已过期，请重新登录')
    if (onAdmin) {
      store.commit('adminLogout')
      router.replace('/admin/login')
    } else {
      store.commit('logout')
      router.replace('/login')
    }
  } else if (error.response && error.response.data && error.response.data.msg) {
    notify(error.response.data.msg)
  } else if (error.message) {
    notify(error.message)
  } else {
    notify('未知错误')
  }
  return Promise.reject(error)
}

export const postRequest = (url, params, config) => {
  return axios(Object.assign({
    method: 'post',
    url,
    data: params,
    transformRequest: [encodeForm],
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  }, config || {}))
}

export const putRequest = (url, params, config) => {
  return axios(Object.assign({
    method: 'put',
    url,
    data: params,
    transformRequest: [encodeForm],
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  }, config || {}))
}

export const getRequest = (url, params, config) => {
  return axios(Object.assign({
    method: 'get',
    url,
    params
  }, config || {}))
}

export const deleteRequest = (url, params, config) => {
  return axios(Object.assign({
    method: 'delete',
    url,
    params
  }, config || {}))
}
