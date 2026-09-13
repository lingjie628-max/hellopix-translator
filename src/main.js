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

new Vue({
  router,
  store,
  render: h => h(App)
}).$mount('#app')
