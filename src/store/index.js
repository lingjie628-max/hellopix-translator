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
    routes: []
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
    }
  }
})
