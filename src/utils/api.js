import axios from 'axios'
import { Message } from 'element-ui'
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
  return config
})

// encodeForm 见 ./encode-form.js —— 抽出去是为了能单测（数组里放对象曾把
// 收款方式页的保存打成「提交的数据不是合法 JSON」）

axios.interceptors.response.use(
  success => success,
  error => {
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
)

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
