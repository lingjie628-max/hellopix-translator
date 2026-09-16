/**
 * 官网独立入口。
 *
 * 为什么要独立：官网（Landing.vue）原本是主应用的一个路由，而主应用在 main.js 里
 * `Vue.use(ElementUI)` 整包引入了 Element UI —— 于是**访客只想看官网，却要下载
 * 整个后台 + 商户端 + 全部 Element 组件**（实测 1.0MB vendors + 292KB app）。
 *
 * 这里只装官网真正用到的东西：
 *   - Vue
 *   - 3 个 Element 组件（button / collapse / collapse-item）
 *   - Message 服务（Landing 里用了一次 $message）
 *   - axios（自己发请求，理由见下）
 *   - 全局主题变量 theme.css
 *
 * 两个刻意的取舍：
 *
 * 1. **不引入 utils/api.js** —— 它顶部 `import router from '../router'`，
 *    而 router 又静态 import 了全部页面组件。哪怕只是 import 一下，
 *    整个后台都会被拖进这个入口，拆分就白做了。所以这里直接用 axios。
 *
 * 2. **不引入 store** —— Landing 的 currencySymbol 是组件内的 computed
 *    （从 /site/info 的 billing 取），不依赖 Vuex。
 *
 * 注意：官网用到的 3 个组件是**按路径引入**的（element-ui/lib/xxx）。
 * 主入口仍走整包引入 —— 实测过，47 个组件按需引入反而比整包大 35%
 * （整包是一个 webpack 产物，terser 能在文件内做跨模块死代码消除；
 *   拆成几十个 CommonJS 模块后这层优化就没了）。
 * 这里只有 3 个组件，不存在那个问题。
 */
import Vue from 'vue'
import axios from 'axios'

import Button from 'element-ui/lib/button'
import Collapse from 'element-ui/lib/collapse'
import CollapseItem from 'element-ui/lib/collapse-item'
import Message from 'element-ui/lib/message'

// 按需样式；base 与 icon 是所有组件共用的基础（图标字体走 icon.css）
import 'element-ui/lib/theme-chalk/base.css'
import 'element-ui/lib/theme-chalk/icon.css'
import 'element-ui/lib/theme-chalk/button.css'
import 'element-ui/lib/theme-chalk/collapse.css'
import 'element-ui/lib/theme-chalk/message.css'
// 全局主题变量：必须排在 element-ui 之后，才能覆盖它的变量
import './assets/theme.css'

import Landing from './components/Landing.vue'

Vue.config.productionTip = false

Vue.use(Button)
Vue.use(Collapse)
Vue.use(CollapseItem)
Vue.prototype.$message = Message

// 自带一个极简请求方法，替代 utils/api.js 里的 getRequest。
// 只做官网需要的：GET + 统一 /apis 前缀 + 返回 { data } 形状（Landing 依赖这个形状）。
Vue.prototype.getRequest = (url, params) =>
  axios.get('/apis' + url, { params }).then(resp => ({ status: resp.status, data: resp.data }))

new Vue({
  render: h => h(Landing)
}).$mount('#app')
