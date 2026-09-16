import Vue from 'vue'
import VueRouter from 'vue-router'
import store from '../store'
import Login from '../components/Login.vue'
import Landing from '../components/Landing.vue'
import Home from '../components/Home.vue'
import HomeIndex from '../components/HomeIndex.vue'
import OrderInfo from '../components/order/OrderInfo.vue'
import OrderDetails from '../components/order/OrderDetails.vue'
import OrderFans from '../components/order/OrderFans.vue'
import OrderDetailsLog from '../components/order/OrderDetailsLog.vue'
import OrderUserLogin from '../components/order/OrderUserLogin.vue'
import OrderShareDetails from '../components/order/OrderShareDetails.vue'
import OrderShareFans from '../components/order/OrderShareFans.vue'
import ShortLink from '../components/shortLink/ShortLink.vue'
import AssistantGroup from '../components/assistant/AssistantGroup.vue'
import TranslateChannels from '../components/translate/TranslateChannels.vue'
import UserRecharge from '../components/user/UserRecharge.vue'
import UserRechargePage from '../components/user/UserRechargePage.vue'
import UserTeam from '../components/user/UserTeam.vue'
import PaySuccess from '../components/paySuccess.vue'
import PayError from '../components/payError.vue'
import Empty from '../components/empty.vue'
import AdminLogin from '../components/admin/AdminLogin.vue'
import AdminLayout from '../components/admin/AdminLayout.vue'
import AdminDashboard from '../components/admin/AdminDashboard.vue'
import AdminUsers from '../components/admin/AdminUsers.vue'
import AdminOrders from '../components/admin/AdminOrders.vue'
import AdminPackages from '../components/admin/AdminPackages.vue'
import AdminRecharges from '../components/admin/AdminRecharges.vue'
import AdminPayments from '../components/admin/AdminPayments.vue'
import AdminCustomers from '@/components/admin/AdminCustomers'
import AdminCollision from '@/components/admin/AdminCollision'
import AdminAccounts from '../components/admin/AdminAccounts.vue'
import AdminFans from '../components/admin/AdminFans.vue'
import AdminLinks from '../components/admin/AdminLinks.vue'
import AdminScripts from '../components/admin/AdminScripts.vue'
import AdminTranslate from '../components/admin/AdminTranslate.vue'
import AdminEngines from '../components/admin/AdminEngines.vue'
import AdminLogs from '../components/admin/AdminLogs.vue'
import AdminSettings from '../components/admin/AdminSettings.vue'
import AdminStaff from '../components/admin/AdminStaff.vue'
import AdminSecurity from '../components/admin/AdminSecurity.vue'
import AdminClients from '../components/admin/AdminClients.vue'
import AdminSupport from '../components/admin/AdminSupport.vue'
import AdminNotices from '../components/admin/AdminNotices.vue'
import AdminVerify from '../components/admin/AdminVerify.vue'
import Register from '../components/Register.vue'
import Forgot from '../components/Forgot.vue'
import RegSuccess from '../components/RegSuccess.vue'

Vue.use(VueRouter)

// '/' 是官网落地页（未登录可看），商户登录移到 '/login'。
// 之前根路径直接渲染登录页 —— 访客打开域名只看到一个登录框，看不到任何产品介绍。
const publicPages = ['/', '/login', '/register', '/forgot', '/regSuccess', '/order/shareDetails', '/order/shareFans', '/empty', '/paySuccess', '/payError']

const routes = [
  { path: '/', name: '官网', component: Landing },
  { path: '/login', name: '登录', component: Login },
  { path: '/register', name: '用户注册', component: Register },
  { path: '/forgot', name: '忘记密码', component: Forgot },
  { path: '/regSuccess', name: '注册成功', component: RegSuccess },
  { path: '/empty', name: '空状态', component: Empty },
  { path: '/paySuccess', name: '支付成功', component: PaySuccess },
  { path: '/payError', name: '支付失败', component: PayError },
  { path: '/order/shareDetails', name: '分享工单', component: OrderShareDetails },
  { path: '/order/shareFans', name: '分享粉丝', component: OrderShareFans },
  { path: '/admin/login', name: '超管登录', component: AdminLogin },
  {
    path: '/admin',
    name: '超管后台',
    component: AdminLayout,
    redirect: '/admin/dashboard',
    children: [
      { path: '/admin/dashboard', name: '超管总览', component: AdminDashboard },
      { path: '/admin/users', name: '商户管理', component: AdminUsers },
      { path: '/admin/orders', name: '全部工单', component: AdminOrders },
      { path: '/admin/accounts', name: '在线账号', component: AdminAccounts },
      { path: '/admin/fans', name: '进粉统计', component: AdminFans },
      { path: '/admin/links', name: '分流链接', component: AdminLinks },
      { path: '/admin/scripts', name: '话术回复', component: AdminScripts },
      { path: '/admin/packages', name: '套餐管理', component: AdminPackages },
      { path: '/admin/recharges', name: '充值流水', component: AdminRecharges },
      { path: '/admin/payments', name: '收款方式', component: AdminPayments },
    { path: '/admin/customers', name: '统一客户', component: AdminCustomers },
    { path: '/admin/collision', name: '撞单规则', component: AdminCollision },
      { path: '/admin/translate', name: '翻译计费', component: AdminTranslate },
      { path: '/admin/engines', name: '翻译通道', component: AdminEngines },
      { path: '/admin/clients', name: '客户端版本', component: AdminClients },
      { path: '/admin/notices', name: '公告管理', component: AdminNotices },
      { path: '/admin/support', name: '帮助与客服', component: AdminSupport },
      { path: '/admin/verify', name: '验证码接口', component: AdminVerify },
      { path: '/admin/settings', name: '系统设置', component: AdminSettings },
      { path: '/admin/logs', name: '登录与审计', component: AdminLogs },
      { path: '/admin/staff', name: '超管账号', component: AdminStaff },
      { path: '/admin/security', name: '账号安全', component: AdminSecurity }
    ]
  },
  {
    path: '/home',
    name: '主页',
    component: Home,
    redirect: '/home/index',
    children: [
      { path: '/home/index', name: '首页', component: HomeIndex, meta: { keepAlive: true } },
      { path: '/order/info', name: '工单管理', component: OrderInfo, meta: { keepAlive: true } },
      { path: '/order/details', name: '工单明细', component: OrderDetails },
      { path: '/order/fans', name: '粉丝明细', component: OrderFans },
      { path: '/order/detailsLog', name: '工单日志', component: OrderDetailsLog },
      { path: '/order/userLogin', name: '登录日志', component: OrderUserLogin },
      { path: '/short/link', name: '分流链接', component: ShortLink },
      { path: '/assistant/Group', name: '聊天翻译', component: AssistantGroup },
      { path: '/translate/channels', name: '翻译通道', component: TranslateChannels },
      { path: '/user/Recharge', name: '充值记录', component: UserRecharge },
      { path: '/user/rechargePage', name: '充值中心', component: UserRechargePage },
      { path: '/user/team', name: '子账号管理', component: UserTeam }
    ]
  }
]

const router = new VueRouter({
  mode: 'hash',
  routes
})

/**
 * 超管后台专用域名。
 *
 * 为什么要按域名判断：前端路由是 hash 模式，服务器拿不到 "#" 之后的内容，
 * 所以没法在 nginx 里把 lindufyht.com 的根路径跳到 /#/admin/login
 * —— 那样浏览器会反复请求 "/" 形成无限重定向（hash 不会回传服务器）。
 * 只能在页面加载后由前端判断域名再跳。
 *
 * 顺带解决了"路径形式访问"的问题：直接打开 lindufyht.com/admin/login 时，
 * SPA 认为 URL 里没有 hash、落到默认路由，同样会走到下面这个跳转。
 */
const ADMIN_HOSTS = ['lindufyht.com', 'www.lindufyht.com']

function isAdminHost() {
  try {
    return ADMIN_HOSTS.includes(String(window.location.hostname || '').toLowerCase())
  } catch (e) {
    return false
  }
}

router.beforeEach((to, from, next) => {
  // 超管域名下不展示官网首页，根路径直接进后台
  if (isAdminHost() && (to.path === '/' || to.path === '')) {
    next('/admin/login')
    return
  }
  if (to.path === '/admin/login') {
    next()
    return
  }
  if (to.path.indexOf('/admin') === 0) {
    if (store.state.admin && store.state.admin.username) {
      next()
    } else {
      next('/admin/login')
    }
    return
  }
  if (publicPages.includes(to.path)) {
    next()
    return
  }
  if (store.state.user && store.state.user.username) {
    if (store.state.user.role === 'sub' && (to.path === '/user/team' || to.path === '/user/rechargePage')) {
      next('/home/index')
      return
    }
    next()
  } else {
    next({ path: '/login', query: { redirect: to.fullPath } })
  }
})

export default router
