import axios from 'axios'
import { Message } from 'element-ui'
import router from '../router'
import store from '../store'

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

function encodeForm(data) {
  if (!data) return ''
  const parts = []
  Object.keys(data).forEach(key => {
    const value = data[key]
    if (value === undefined || value === null) return
    if (Array.isArray(value)) {
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value.join(',')))
    } else if (typeof value === 'object') {
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(JSON.stringify(value)))
    } else {
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value))
    }
  })
  return parts.join('&')
}

axios.interceptors.response.use(
  success => success,
  error => {
    const status = error.response && error.response.status
    if (status === 429) {
      Message.error({ message: '请求过于频繁，请稍后再试' })
    } else if (status === 504 || status === 404) {
      Message.error({ message: '服务器连接失败' })
    } else if (status === 403) {
      Message.error({ message: '权限不足，请联系管理员' })
    } else if (status === 401) {
      const onAdmin = router.currentRoute.path.indexOf('/admin') === 0
      Message.error({ message: onAdmin ? '超管尚未登录' : '尚未登录，请登录' })
      if (onAdmin) {
        store.commit('adminLogout')
        router.replace('/admin/login')
      } else {
        store.commit('logout')
        router.replace('/')
      }
    } else if (error.response && error.response.data && error.response.data.msg) {
      Message.error({ message: error.response.data.msg })
    } else if (error.message) {
      Message.error({ message: error.message })
    } else {
      Message.error({ message: '未知错误' })
    }
    return Promise.reject(error)
  }
)

export const postRequest = (url, params) => {
  return axios({
    method: 'post',
    url,
    data: params,
    transformRequest: [encodeForm],
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  })
}

export const putRequest = (url, params) => {
  return axios({
    method: 'put',
    url,
    data: params,
    transformRequest: [encodeForm],
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  })
}

export const getRequest = (url, params) => {
  return axios({
    method: 'get',
    url,
    params
  })
}

export const deleteRequest = (url, params) => {
  return axios({
    method: 'delete',
    url,
    params
  })
}
