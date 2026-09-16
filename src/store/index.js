import Vue from 'vue'
import Vuex from 'vuex'

Vue.use(Vuex)

function loadJSON(key) {
  try {
    return JSON.parse(window.sessionStorage.getItem(key)) || {}
  } catch (e) {
    return {}
  }
}

export default new Vuex.Store({
  state: {
    user: loadJSON('user'),
    admin: loadJSON('admin'),
    routes: [],
    // 计费货币。启动时从 /site/info 取一次，全站金额显示统一用它。
    // 之前后台各页把符号写死成 ¥，而官网按后台设置显示 $，
    // 同一个价格在管理员和访客眼里是两种货币 —— 实测发现的不一致。
    currency: 'USD'
  },
  getters: {
    currencySymbol(state) {
      const map = { USD: '$', CNY: '¥', HKD: 'HK$', JPY: '¥', EUR: '€' }
      return map[state.currency] || '$'
    },
    currencyName(state) {
      const map = { USD: '美元', CNY: '人民币', HKD: '港币', JPY: '日元', EUR: '欧元' }
      return map[state.currency] || state.currency
    }
  },
  mutations: {
    login(state, user) {
      state.user = user || {}
      window.sessionStorage.setItem('user', JSON.stringify(state.user))
    },
    logout(state) {
      state.user = {}
      window.sessionStorage.removeItem('user')
    },
    adminLogin(state, admin) {
      state.admin = admin || {}
      window.sessionStorage.setItem('admin', JSON.stringify(state.admin))
    },
    adminLogout(state) {
      state.admin = {}
      window.sessionStorage.removeItem('admin')
    },
    setCurrency(state, code) {
      state.currency = String(code || 'USD').toUpperCase()
    }
  }
})
