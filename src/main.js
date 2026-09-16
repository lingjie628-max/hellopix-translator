import Vue from 'vue'
import App from './App.vue'
import router from './router'
import store from './store'
import ElementUI from 'element-ui'
import 'element-ui/lib/theme-chalk/index.css'
// 全局主题变量：必须排在 element-ui 之后，才能覆盖它的 --el-* 变量
import './assets/theme.css'
import { postRequest, getRequest, putRequest, deleteRequest } from './utils/api'
import { formatDateTime, formateStatus } from './utils/filters'

Vue.config.productionTip = false
Vue.use(ElementUI)

Vue.prototype.postRequest = postRequest
Vue.prototype.getRequest = getRequest
Vue.prototype.putRequest = putRequest
Vue.prototype.deleteRequest = deleteRequest

Vue.filter('formatDateTime', formatDateTime)
Vue.filter('formateStatus', formateStatus)

// 金额货币符号全局可用：任何组件里写 {{ currencySymbol }} 即可。
// 值来自后台「系统设置 → 价格货币」，所以官网、超管后台、商户端三处永远一致。
//
// 注意：这段曾在一次实验失败后被 `git checkout src/main.js` 整体回退掉，
// 导致 6 个组件（后台 5 个 + 商户端充值页）的金额显示成 "undefined0" / "NaN"。
// 构建与单测都发现不了（它们不渲染 UI），只有实际打开页面才看得到。
Vue.mixin({
  computed: {
    currencySymbol() {
      return this.$store.getters.currencySymbol
    },
    currencyName() {
      return this.$store.getters.currencyName
    }
  }
})

// 启动时取一次计费设置（/site/info 是公开接口，未登录也能拿到），
// 否则 currency 停留在 store 的默认值，与后台设置不一致。
getRequest('/site/info').then(resp => {
  const billing = (resp && resp.data && resp.data.billing) || {}
  if (billing.currency) store.commit('setCurrency', billing.currency)
}).catch(() => {})

new Vue({
  router,
  store,
  render: h => h(App)
}).$mount('#app')
