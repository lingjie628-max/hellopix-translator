<template>
  <div class="landing">
    <!-- 顶部导航 -->
    <header class="nav" :class="{ stuck: scrolled }">
      <div class="wrap nav-inner">
        <a class="brand" href="javascript:;" @click="scrollTo('top')">
          <img src="/icon.png" alt="" class="brand-mark" @error="markFailed = true" v-show="!markFailed">
          <span class="brand-name">{{ site.siteName || 'Hello Pix' }}</span>
        </a>
        <nav class="nav-links">
          <a href="javascript:;" @click="scrollTo('scenarios')">产品介绍</a>
          <a href="javascript:;" @click="scrollTo('platforms')">支持平台</a>
          <a href="javascript:;" @click="scrollTo('pricing')">定价标准</a>
          <a href="javascript:;" @click="scrollTo('download')">软件下载</a>
          <a v-if="faqs.length" href="javascript:;" @click="scrollTo('faq')">常见问题</a>
          <a href="javascript:;" @click="scrollTo('contact')">联系我们</a>
        </nav>
        <div class="nav-actions">
          <theme-toggle></theme-toggle>
          <el-button size="small" @click="go('/login')">登录</el-button>
          <el-button size="small" type="primary" @click="go('/register')">注册</el-button>
        </div>
      </div>
    </header>

    <!-- 主视觉 -->
    <section id="top" class="hero">
      <div class="wrap hero-inner">
        <div class="hero-copy">
          <div class="pill" v-if="site.announcement">{{ site.announcement }}</div>
          <h1><span class="hl">{{ site.siteName || 'Hello Pix' }}</span> 与世界高效相连</h1>
          <p class="lead">
            我们为跨语言沟通场景而生：一台电脑同时登录多个账号，
            收发消息自动翻译，跨越语言障碍 ——
            适用于跨境电商客服、出海业务拓展、国际化社群运维等场景。
          </p>
          <div class="hero-cta">
            <el-button type="primary" size="medium" @click="go('/register')">立即免费注册</el-button>
            <el-button size="medium" @click="scrollTo('download')">下载客户端</el-button>
          </div>
          <div class="hero-meta">
            <span v-for="os in primaryDownloads" :key="os.key" class="os-chip">
              <i :class="os.icon"></i> {{ os.label }}
            </span>
            <span class="os-chip"><i class="el-icon-lock"></i> 会话加密存储</span>
          </div>
        </div>
        <div class="hero-art">
          <div class="art-card">
            <div class="art-row"><span class="dot"></span> 客户 · 日本語</div>
            <div class="art-bubble theirs">こんにちは、在庫はありますか？</div>
            <div class="art-bubble mine">你好，库存是有的</div>
            <div class="art-row"><span class="dot"></span> 你 · 中文</div>
            <div class="art-bubble mine">需要多少件？</div>
            <div class="art-bubble theirs">100 件をお願いします</div>
          </div>
        </div>
      </div>
    </section>

    <!-- 多元化场景 -->
    <section id="scenarios" class="section">
      <div class="wrap">
        <h2>多元化产品满足多样化场景</h2>
        <p class="section-sub">同一套工具，覆盖从客服到运营的完整链路</p>
        <div class="scenarios">
          <div class="scene" v-for="(s, i) in scenarios" :key="s.title" :class="'scene-' + (i + 1)">
            <span class="num">{{ String(i + 1).padStart(2, '0') }}</span>
            <i :class="s.icon"></i>
            <h3>{{ s.title }}</h3>
            <p>{{ s.desc }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- 客户端下载 -->
    <section id="download" class="section alt">
      <div class="wrap center">
        <h2>客户端免费下载</h2>
        <p class="section-sub">支持 Windows 与 macOS，安装即用</p>
        <div class="dl-row">
          <a
            v-for="d in primaryDownloads" :key="d.key"
            class="dl-round" :href="d.url" @click="onDownload($event, d)">
            <span class="dl-ico"><i :class="d.icon"></i></span>
            <strong>下载{{ d.label }}版</strong>
            <em>{{ d.note }}</em>
          </a>
          <div v-if="!primaryDownloads.length" class="dl-round disabled">
            <span class="dl-ico"><i class="el-icon-loading"></i></span>
            <strong>准备中</strong><em>请稍后刷新</em>
          </div>
        </div>
        <!-- 安装引导：macOS 对未公证应用的拦截是"装不上"的头号原因，所以紧跟
             下载按钮给出解法。默认折叠，一是避免在落地页制造"这软件有问题"
             的错觉，二是它对绝大多数用户是无关内容。用原生 details 元素实现，
             不需要 JS，也自带无障碍语义。 -->
        <details v-if="hasMacDownload" class="install-help">
          <summary>macOS 首次打开被系统拦截？点这里</summary>
          <div class="install-help-body">
            <p class="install-help-lead">
              这不是安装包损坏，是 macOS 对<strong>尚未公证</strong>的应用的默认拦截。
              按下面的步骤放行一次，之后就和自己装的软件一样，双击即可打开。
              <br>安装包里也附了同一份说明（<code class="inline">首次打开说明.txt</code>），不用回来找。
            </p>
            <p class="install-help-step"><b>第 1 步：先把 Hello Pix 拖进「应用程序」文件夹，再从那里双击打开</b>
              —— 别直接在 dmg 或「下载」里运行，那样系统会把它当成临时文件。
              <br><b class="warn">装过旧版本的话，必须让它替换掉旧的那个</b>：Finder 会问「已存在同名项目，
              要替换吗？」，选<strong>「替换」</strong>。否则你双击的仍然是旧版本，怎么放行都没用
              —— 这是最常见的一种「试了还是打不开」。</p>
            <ol>
              <li>
                <b>如果你的系统是 macOS 15（Sequoia）或更新</b>（大多数用户）：
                双击后会出现「无法验证开发者」的提示，点「完成」关掉。然后打开
                <strong>系统设置 → 隐私与安全性</strong>，向下滚到「安全性」一节，
                点「<strong>仍要打开</strong>」，输入开机密码即可。
                这个入口在你尝试打开后约一小时内有效。
              </li>
              <li>
                <b>如果你的系统是 macOS 14 或更早</b>：在「应用程序」里
                <strong>右键点 Hello Pix → 打开</strong>，再在弹窗里点一次「打开」。
              </li>
              <li>
                <b>如果提示「已损坏，无法打开」</b>：说明你装的是 0.1.6 或更早的版本，
                它的签名有缺陷、系统不给放行入口，<strong>怎么点都没用</strong>。
                请重新下载上方的新版，并确认替换掉「应用程序」里的旧版本。
              </li>
            </ol>
            <p class="install-help-alt">
              不想点这么多？也可以打开「终端」，粘贴下面这行回车，效果一样（把隔离标记去掉）：
              <code>xattr -cr /Applications/Hello\ Pix.app</code>
            </p>
            <p class="install-help-foot">
              我们正在申请 Apple 开发者证书并做公证。完成后连这一步都不再需要，双击即开。
            </p>
          </div>
        </details>
        <p v-if="extraDownloads.length" class="extra-dl">
          其他版本：
          <a v-for="d in extraDownloads" :key="d.url" :href="d.url" @click="onDownload($event, d)">{{ d.label }}</a>
        </p>
      </div>
    </section>

    <!-- 产品优势 -->
    <section id="advantages" class="section">
      <div class="wrap">
        <h2>产品优势</h2>
        <p class="section-sub">把稳定与安全放在功能之前</p>
        <div class="grid advantages">
          <div class="adv" v-for="a in advantages" :key="a.title">
            <span class="adv-ico"><i :class="a.icon"></i></span>
            <h3>{{ a.title }}</h3>
            <p>{{ a.desc }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- 支持平台 -->
    <section id="platforms" class="section alt">
      <div class="wrap">
        <h2>支持平台</h2>
        <p class="section-sub">
          已适配 {{ platforms.length }} 个平台，可多开并行、互不干扰
        </p>
        <div class="plats">
          <span class="plat" v-for="p in platforms" :key="p.id || p.name">{{ p.name }}</span>
          <span v-if="!platforms.length" class="plat muted">加载中…</span>
        </div>
      </div>
    </section>

    <!-- 定价 -->
    <section id="pricing" class="section">
      <div class="wrap">
        <h2>定价标准</h2>
        <!-- 本站按字符计费，没有按月/按年这回事，所以价格后面不带任何时间单位 -->
        <p class="section-sub">按字符计费，套餐含翻译字符额度</p>
        <div class="grid pricing">
          <div class="price-card" v-for="(p, i) in packages" :key="p.code" :class="{ featured: i === 1 }">
            <div class="tag" v-if="i === 1">最受欢迎</div>
            <h3>{{ p.title }}</h3>
            <p class="sub">{{ p.subtitle }}</p>
            <div class="amount"><em>{{ currencySymbol }}</em>{{ formatPrice(p.price) }}</div>
            <p class="quota">含 {{ formatChars(p.includedChars) }}字符</p>
            <ul>
              <li><i class="el-icon-check"></i>
                {{ p.portUnlimited || !p.portLimit ? '账号数量不限' : '可开 ' + p.portLimit + ' 个账号' }}
              </li>
              <li v-for="(h, hi) in cardHighlights(p)" :key="hi"><i class="el-icon-check"></i> {{ h }}</li>
            </ul>
            <el-button :type="i === 1 ? 'primary' : 'default'" style="width:100%" @click="go('/register')">
              立即开通
            </el-button>
          </div>
          <div v-if="!packages.length" class="price-card muted">套餐加载中…</div>
        </div>
      </div>
    </section>

    <!-- 常见问题 -->
    <section id="faq" class="section alt" v-if="faqs.length">
      <div class="wrap narrow">
        <h2>常见问题</h2>
        <div class="faq-card">
          <el-collapse accordion>
            <el-collapse-item v-for="q in faqs" :key="q.id" :title="q.question">
              <div class="faq-a">{{ q.answer }}</div>
            </el-collapse-item>
          </el-collapse>
        </div>
      </div>
    </section>

    <!-- 用户反馈：仅在后台配置了真实评价时才展示。
         这里刻意不做假数据 —— 编造用户评价是欺骗访客，也会给你带来风险。 -->
    <section id="reviews" class="section" v-if="testimonials.length">
      <div class="wrap">
        <h2>用户使用反馈</h2>
        <p class="section-sub">来自真实用户</p>
        <div class="grid reviews">
          <div class="review" v-for="(r, i) in testimonials" :key="i">
            <div class="stars"><i class="el-icon-star-on" v-for="n in 5" :key="n"></i></div>
            <p>{{ r.content }}</p>
            <div class="who">
              <span class="avatar">{{ (r.name || '?').slice(0, 1) }}</span>
              <strong>{{ r.name }}</strong>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 结尾行动号召 -->
    <section class="cta-band">
      <div class="wrap center">
        <h2>{{ site.siteName || 'Hello Pix' }}智能翻译软件</h2>
        <p>与世界各地高效连接</p>
        <el-button type="primary" size="medium" @click="go('/register')">立即免费注册</el-button>
      </div>
    </section>

    <!-- 页脚 -->
    <footer id="contact" class="foot">
      <div class="wrap foot-cols">
        <div class="foot-brand">
          <div class="brand">
            <img src="/icon.png" alt="" class="brand-mark" v-show="!markFailed">
            <span class="brand-name">{{ site.siteName || 'Hello Pix' }}</span>
          </div>
          <p class="foot-note">{{ site.supportNote || '多开账号 · 聊天翻译 · 自动翻译' }}</p>
        </div>
        <div class="foot-col">
          <h4>客户端下载</h4>
          <a v-for="d in allDownloads" :key="d.url" :href="d.url" @click="onDownload($event, d)">{{ d.label }}</a>
          <span v-if="!allDownloads.length" class="muted">准备中</span>
        </div>
        <div class="foot-col">
          <h4>服务支持</h4>
          <a href="javascript:;" @click="go('/register')">注册账号</a>
          <a href="javascript:;" @click="go('/forgot')">忘记密码</a>
          <a href="javascript:;" @click="go('/login')">商户登录</a>
          <a v-if="site.guideUrl" :href="site.guideUrl" target="_blank" rel="noopener">帮助中心</a>
          <a href="javascript:;" @click="scrollTo('faq')">常见问题</a>
        </div>
        <!-- 「联系我们」只放真正的联系方式。
             原先把「商户登录」放在这一列是归类错误 —— 那是导航入口而不是联系方式；
             而且没配其它联系方式时整列只剩它一个，看着莫名其妙。
             没有任何联系方式时整列不渲染，不留空列。 -->
        <div class="foot-col" v-if="contactLinks.length">
          <h4>联系我们</h4>
          <a v-for="c in contactLinks" :key="c.href" :href="c.href" target="_blank" rel="noopener">{{ c.label }}</a>
        </div>
      </div>
      <div class="wrap copyright">
        © {{ year }} {{ site.siteName || 'Hello Pix' }}. All rights reserved.
      </div>
    </footer>
  </div>
</template>

<script>
import ThemeToggle from './ThemeToggle.vue'

// 场景与优势是产品定位，属于"我们怎么讲自己"，放前端常量：
// 不随运营改动，也能避免后台被改坏导致官网没内容。
const SCENARIOS = [
  { icon: 'el-icon-service', title: '集成式跨境电商客服', desc: '多店铺多账号同时在线，客户消息进来即时译成中文，回复自动译成对方语言。' },
  { icon: 'el-icon-position', title: '沉浸式出海业务拓展', desc: '与海外客户无障碍沟通，询盘、报价、售后一屏处理，不再等翻译。' },
  { icon: 'el-icon-chat-dot-round', title: '全球化交友畅聊', desc: '跨语言聊天自动互译，交朋友不再被语言拦住。' },
  { icon: 'el-icon-user-solid', title: '国际化社群运维', desc: '多群组并行管理，群消息自动翻译，重要动向不漏看。' },
  { icon: 'el-icon-data-line', title: '便捷式业务管理与分析', desc: '账号、会话与翻译用量集中管理，业务状况一目了然。' }
]

const ADVANTAGES = [
  { icon: 'el-icon-lock', title: '信息安全', desc: '会话与厂商密钥加密存储，本地不落明文，敏感信息不外泄。' },
  { icon: 'el-icon-cpu', title: '服务稳定', desc: '海外独立线路，自动测速择优，长时间在线不掉线。' },
  { icon: 'el-icon-lightning', title: '响应迅速', desc: '消息到达即翻译，无需复制粘贴，对话节奏不中断。' },
  { icon: 'el-icon-headset', title: '专业客服', desc: '在线答疑解惑，使用问题快速响应。' }
]

export default {
  components: { ThemeToggle },
  data() {
    return {
      scrolled: false,
      markFailed: false,
      site: {},
      packages: [],
      faqs: [],
      platforms: [],
      scenarios: SCENARIOS,
      advantages: ADVANTAGES,
      year: new Date().getFullYear()
    }
  },
  computed: {
    releaseList() {
      return Array.isArray(this.site.downloads) ? this.site.downloads : []
    },
    /** 主推两个：Windows 安装版、macOS Apple 芯片版（按标题/架构显式挑选，不依赖录入顺序） */
    primaryDownloads() {
      const list = this.releaseList
      const isWin = r => /windows|win/i.test(`${r.releaseGroup} ${r.os}`)
      const isMac = r => /mac|darwin/i.test(`${r.releaseGroup} ${r.os}`)
      const items = []
      const win = list.find(r => isWin(r) && /setup|安装/i.test(`${r.title} ${r.url}`)) || list.find(isWin)
      if (win) items.push({ key: 'windows', label: 'Windows', icon: 'el-icon-monitor', url: win.url, note: win.note || `v${win.version}` })
      const mac = list.find(r => isMac(r) && /arm|apple|m[0-9]/i.test(`${r.arch} ${r.title}`)) || list.find(isMac)
      if (mac) items.push({ key: 'macos', label: 'macOS', icon: 'el-icon-apple', url: mac.url, note: mac.note || `v${mac.version}` })
      return items
    },
    extraDownloads() {
      const used = new Set(this.primaryDownloads.map(i => i.url))
      return this.releaseList.filter(r => !used.has(r.url)).map(r => ({ label: r.title || r.group, url: r.url, note: r.note }))
    },
    allDownloads() {
      return this.releaseList.map(r => ({ label: r.title || r.group, url: r.url, note: r.note }))
    },
    /** 有没有 macOS 下载项 —— 决定是否展示安装引导（Windows 端没有这个问题） */
    hasMacDownload() {
      return this.releaseList.some(r => /mac|darwin/i.test(`${r.releaseGroup} ${r.os}`))
    },
    /** 真实联系方式，来自后台「帮助与客服」与「官方链接」配置；没配就不显示这一列 */
    contactLinks() {
      const list = []
      if (this.site.telegramUrl) {
        const account = String(this.site.telegram || '').trim()
        list.push({ label: account ? `Telegram ${account}` : 'Telegram 客服', href: this.site.telegramUrl })
      }
      if (this.site.officialUrl) list.push({ label: '官方渠道', href: this.site.officialUrl })
      return list
    },
    /** 真实用户评价，后台没配就不显示这一节 */    testimonials() {
      const list = this.site.testimonials
      if (!Array.isArray(list)) return []
      return list.filter(t => t && t.content && t.name)
    },
    /** 货币符号来自后台设置（/apis/site/info 的 billing），页面不写死 */
    currencySymbol() {
      const map = { USD: '$', CNY: '¥', HKD: 'HK$', JPY: '¥', EUR: '€' }
      return map[(this.site.billing || {}).currency] || '$'
    }
  },
  mounted() {
    window.addEventListener('scroll', this.onScroll, { passive: true })
    this.load()
  },
  beforeDestroy() {
    window.removeEventListener('scroll', this.onScroll)
  },
  methods: {
    onScroll() {
      this.scrolled = window.scrollY > 12
    },
    load() {
      this.fetchSection('/site/info', data => { this.site = data || {} })
      this.fetchSection('/site/packages', data => { this.packages = (data && data.rows) || [] })
      this.fetchSection('/site/faqs', data => { this.faqs = (data && data.rows) || [] })
      this.fetchSection('/site/platforms', data => { this.platforms = (data && data.rows) || [] })
    },
    /**
     * 带重试的分区加载。
     * 官网是访客看到的第一屏，任何一次请求抖动（服务重启、网络瞬断）都会在页面上
     * 留下"套餐加载中…"这种空白区块，而且用户不刷新就永远是空的 —— 实测踩到过。
     * 失败后自动退避重试两次。
     */
    fetchSection(path, apply, attempt) {
      const tried = attempt || 0
      this.getRequest(path).then(resp => {
        apply(resp && resp.data)
      }).catch(() => {
        if (tried < 2) {
          setTimeout(() => this.fetchSection(path, apply, tried + 1), 700 * (tried + 1))
        }
      })
    },
    /**
     * 跳转到主应用的路由。
     * 官网有**独立入口**（见 src/landing.js），那里没有 vue-router，
     * 所以不能只依赖 $router —— 独立入口下直接跳主应用的 hash 路由。
     * 两条路径最终落到同一套页面，行为一致。
     */
    go(path) {
      if (this.$router) { this.$router.push(path); return }
      window.location.href = '/index.html#' + path
    },
    scrollTo(id) {
      if (id === 'top') { window.scrollTo({ top: 0, behavior: 'smooth' }); return }
      const el = document.getElementById(id)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    },
    onDownload(event, item) {
      if (!item.url) { event.preventDefault(); this.$message.info(`${item.label} 即将上线`); return }
      event.preventDefault()
      window.open(item.url, '_blank', 'noopener')
    },
    formatPrice(value) {
      const n = Number(value || 0)
      return Number.isInteger(n) ? String(n) : n.toFixed(2)
    },
    formatChars(value) {
      const n = Number(value || 0)
      return n >= 10000 ? (n / 10000) + ' 万' : String(n)
    },
    /**
     * 权益列表里若含"150万字符"这类纯额度项就跳过 ——
     * 额度已经单独大字展示，重复列一遍显得啰嗦。
     */
    cardHighlights(pkg) {
      return (pkg.highlights || []).filter(h => !/^[\d.,]+\s*万?\s*(翻译)?字符$/.test(String(h).trim()))
    }
  }
}
</script>

<style scoped>
/* 背景与网页端（登录页/超管后台）完全一致：同一套 --w-bg-grad 渐变，
   日间浅蓝、夜间深蓝，随主题切换。fixed 让渐变固定，内容在其上滚动。 */
.landing {
  min-height: 100%;
  background: var(--w-bg-grad, linear-gradient(160deg, #eef3fb 0%, #e6eef9 45%, #dbe7f6 100%));
  background-attachment: fixed;
  background-size: cover;
  color: var(--w-text, #1f2937);
}
.wrap { max-width: 1140px; margin: 0 auto; padding: 0 24px; }
.wrap.narrow { max-width: 780px; }
.center { text-align: center; }

/* ---------- 导航 ---------- */
.nav {
  position: sticky; top: 0; z-index: 20;
  background: var(--w-nav-bg, rgba(255, 255, 255, 0.86));
  backdrop-filter: blur(12px);
  border-bottom: 1px solid transparent;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.nav.stuck { border-bottom-color: var(--w-border, #e5e7eb); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.04); }
.nav-inner { display: flex; align-items: center; gap: var(--w-space-5); height: var(--w-space-8); }
.brand { display: flex; align-items: center; gap: var(--w-space-2); font-weight: 700; text-decoration: none; }
.brand-mark { width: 30px; height: 30px; border-radius: var(--w-radius-sm); }
.brand-name { font-size: 17px; color: var(--w-text-strong, #111827); white-space: nowrap; }
.nav-links { display: flex; gap: 20px; margin-left: auto; font-size: 14px; }
.nav-links a { color: var(--w-text-muted, #4b5563); text-decoration: none; white-space: nowrap; }
.nav-links a:hover { color: var(--w-accent, #1677ff); }
.nav-actions { display: flex; align-items: center; gap: 8px; }

/* ---------- 主视觉 ---------- */
/* 不再自绘渐变：让页面背景直接透出来，和网页端观感一致。
   仅加一层很淡的径向光晕做视觉重心。 */
.hero { position: relative; padding: 84px 0 68px; overflow: hidden; }
.hero::before {
  content: '';
  position: absolute; inset: -20% -10% auto -10%; height: 620px;
  background: radial-gradient(ellipse at 30% 20%, rgb(var(--w-accent-rgb, 22 119 255) / 0.1), transparent 60%);
  pointer-events: none;
}
.hero-inner { position: relative; display: grid; grid-template-columns: 1.05fr 0.95fr; gap: 48px; align-items: center; }
.pill {
  display: inline-block; margin-bottom: 16px; padding: 4px 12px; border-radius: var(--w-radius-pill); font-size: 12px;
  color: var(--w-accent-text, #0958d9);
  background: var(--w-accent-soft-bg, rgba(22, 119, 255, 0.08));
  border: 1px solid var(--w-accent-soft-border, rgba(22, 119, 255, 0.18));
}
.hero h1 { font-size: 40px; line-height: 1.25; margin: 0 0 var(--w-space-4); color: var(--w-text-strong, #0f172a); }
.hero h1 .hl { color: var(--w-accent, #1677ff); }
.lead { font-size: 16px; line-height: 1.8; color: var(--w-text-muted, #4b5563); margin: 0 0 26px; }
.hero-cta { display: flex; gap: 12px; flex-wrap: wrap; }
.hero-meta { margin-top: var(--w-space-5); display: flex; gap: var(--w-space-3); flex-wrap: wrap; }
.os-chip { font-size: 12px; padding: var(--w-space-1) var(--w-space-3); border-radius: var(--w-radius-sm); color: var(--w-text-muted, #4b5563); background: var(--w-surface-2, #f3f4f6); }
.hero-art { display: flex; justify-content: center; }
.art-card {
  width: 100%; max-width: 360px; padding: var(--w-space-4); border-radius: var(--w-radius-lg);
  background: var(--w-surface, #fff); border: 1px solid var(--w-border, #e5e7eb);
  box-shadow: var(--w-shadow, 0 18px 50px rgba(15, 23, 42, 0.12));
}
.art-row { display: flex; align-items: center; gap: var(--w-space-1); font-size: 11px; color: var(--w-text-muted, #6b7280); margin: var(--w-space-2) 0 var(--w-space-1); }
.dot { width: 6px; height: 6px; border-radius: 50%; background: #22c55e; }
.art-bubble { max-width: 82%; padding: var(--w-space-2) var(--w-space-3); border-radius: var(--w-radius-md); font-size: 13px; line-height: 1.5; margin-bottom: 8px; }
.art-bubble.theirs { background: var(--w-surface-2, #f3f4f6); color: var(--w-text, #1f2937); }
.art-bubble.mine { background: linear-gradient(135deg, #2563eb, #0e7490); color: #fff; margin-left: auto; }

/* ---------- 区块 ---------- */
.section { padding: 72px 0; }
/* 分节色带：半透明铺层，既区分区块又不遮住渐变背景 */
.section.alt { background: var(--w-band, rgba(255, 255, 255, 0.55)); }
.section h2 { font-size: 29px; margin: 0 0 var(--w-space-3); text-align: center; color: var(--w-text-strong, #0f172a); letter-spacing: 0.01em; }
.section-sub { text-align: center; color: var(--w-text-muted, #6b7280); margin: 0 0 40px; font-size: 14px; }
.grid { display: grid; gap: var(--w-space-4); }

/* 场景卡 */
.scenarios { display: grid; gap: var(--w-space-4); grid-template-columns: repeat(6, 1fr); }
.scene {
  position: relative; padding: 24px 20px; border-radius: var(--w-radius-lg); overflow: hidden;
  background: var(--w-surface, #fff); border: 1px solid var(--w-border, #e5e7eb);
  box-shadow: var(--w-card-shadow, 0 6px 24px rgba(15, 23, 42, 0.07));
  transition: transform 0.18s ease, box-shadow 0.18s ease;
}
.scene:hover { transform: translateY(-4px); box-shadow: var(--w-card-shadow-hover, 0 16px 40px rgba(15, 23, 42, 0.13)); }
/* 前两张占 3 列（第一行两张大卡），后三张各占 2 列 —— 与参考站同构但用我们的配色 */
.scene-1, .scene-2 { grid-column: span 3; }
.scene-3, .scene-4, .scene-5 { grid-column: span 2; }
.scene .num {
  position: absolute; top: 14px; right: 16px;
  font-size: 30px; font-weight: 800; line-height: 1;
  color: var(--w-accent, #1677ff); opacity: 0.13;
}
.scene i { font-size: 26px; color: var(--w-accent, #1677ff); }
.scene h3 { font-size: 16px; margin: 12px 0 8px; color: var(--w-text-strong, #111827); }
.scene p { font-size: 13px; line-height: 1.75; color: var(--w-text-muted, #6b7280); margin: 0; }

/* 下载 */
.dl-row { display: flex; gap: 40px; justify-content: center; flex-wrap: wrap; }
.dl-round { display: flex; flex-direction: column; align-items: center; gap: 8px; text-decoration: none; }
.dl-ico {
  width: 78px; height: 78px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--w-surface, #fff); border: 1px solid var(--w-border, #e5e7eb);
  box-shadow: var(--w-card-shadow, 0 6px 24px rgba(15, 23, 42, 0.07));
  transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
}
.dl-round:hover .dl-ico {
  transform: translateY(-4px);
  border-color: var(--w-accent, #1677ff);
  box-shadow: var(--w-card-shadow-hover, 0 16px 40px rgba(15, 23, 42, 0.13));
}
.dl-ico i { font-size: 30px; color: var(--w-accent, #1677ff); }
.dl-round strong { font-size: 14px; color: var(--w-text-strong, #111827); }
.dl-round em { font-size: 12px; font-style: normal; color: var(--w-text-muted, #9ca3af); }
.dl-round.disabled { opacity: 0.55; }
.extra-dl { margin-top: 24px; font-size: 13px; text-align: center; color: var(--w-text-muted, #6b7280); }
.extra-dl a { color: var(--w-accent, #1677ff); text-decoration: none; margin: 0 3px; }
.extra-dl a:hover { text-decoration: underline; }

/* 安装引导。默认折叠：它只对 Mac 用户里有拦截遭遇的那部分人有用，
   常开会在首页制造"这软件装不上"的错觉。 */
.install-help {
  max-width: 640px; margin: 30px auto 0; text-align: left;
  padding: 0 20px; border-radius: var(--w-radius-lg, 12px);
  background: var(--w-surface, #fff); border: 1px solid var(--w-border, #e5e7eb);
}
.install-help summary {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 15px 0; cursor: pointer; font-size: 14px; font-weight: 600;
  color: var(--w-text, #111827); list-style: none;
}
.install-help summary::-webkit-details-marker { display: none; }
.install-help summary::after { content: '▾'; color: var(--w-text-muted, #6b7280); transition: transform 0.18s ease; }
.install-help[open] summary::after { transform: rotate(180deg); }
.install-help[open] summary { border-bottom: 1px solid var(--w-border, #e5e7eb); }
.install-help-body { padding: 15px 0 20px; font-size: 13px; line-height: 1.85; color: var(--w-text-muted, #6b7280); }
.install-help-body ol { margin: 0 0 0 18px; padding: 0; }
.install-help-body li { margin-bottom: 12px; }
.install-help-body b { color: var(--w-text, #111827); }
.install-help-lead { margin: 0 0 10px; }
.install-help-step { margin: 0 0 12px; }
/* 「必须替换旧版本」这句是客户最常踩的坑（双击的其实是没换掉的旧版），
   给一点视觉权重，别让它淹没在正文里。 */
.install-help-step .warn { color: #b45309; }
.install-help-alt { margin: 14px 0 0; }
.install-help-body code {
  display: inline-block; margin-top: 8px; padding: 7px 11px; border-radius: 6px;
  background: var(--w-code-bg, #f3f4f6); color: var(--w-text, #111827);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  word-break: break-all;
}
/* 行内引用文件名时用，不要块级的那种大内边距 */
.install-help-body code.inline {
  display: inline; margin: 0; padding: 1px 6px; font-size: 12px;
  word-break: normal;
}
.install-help-foot { margin: 14px 0 0; font-size: 12px; }

/* 产品优势 */
.advantages { grid-template-columns: repeat(4, 1fr); }
.adv { text-align: center; padding: 8px; }
.adv-ico {
  width: 68px; height: 68px; margin: 0 auto 14px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--w-surface, #fff);
  border: 1px solid var(--w-border, #e5e7eb);
  box-shadow: var(--w-card-shadow, 0 6px 24px rgba(15, 23, 42, 0.07));
}
.adv-ico i { font-size: 28px; color: var(--w-accent, #1677ff); }
.adv h3 { font-size: 16px; margin: 0 0 8px; color: var(--w-text-strong, #111827); }
.adv p { font-size: 13px; line-height: 1.75; color: var(--w-text-muted, #6b7280); margin: 0; }

/* 支持平台：用 chips 而不是卡片，数量多时更紧凑 */
.plats { display: flex; flex-wrap: wrap; gap: var(--w-space-3); justify-content: center; }
.plat {
  padding: 8px 14px; border-radius: var(--w-radius-pill); font-size: 13px;
  background: var(--w-surface, #fff); border: 1px solid var(--w-border, #e5e7eb);
  color: var(--w-text, #374151);
}
.plat.muted { color: var(--w-text-muted, #9ca3af); }

/* 定价 */
.pricing { grid-template-columns: repeat(3, 1fr); align-items: start; }
.price-card {
  position: relative; padding: var(--w-space-6) var(--w-space-5); border-radius: var(--w-radius-lg);
  background: var(--w-surface, #fff); border: 1px solid var(--w-border, #e5e7eb);
  box-shadow: var(--w-card-shadow, 0 6px 24px rgba(15, 23, 42, 0.07));
  transition: transform 0.18s ease, box-shadow 0.18s ease;
}
.price-card:hover { transform: translateY(-4px); box-shadow: var(--w-card-shadow-hover, 0 16px 40px rgba(15, 23, 42, 0.13)); }
.price-card.featured { border-color: var(--w-accent, #1677ff); box-shadow: 0 16px 40px rgba(22, 119, 255, 0.12); }
.price-card .tag {
  position: absolute; top: -11px; left: 50%; transform: translateX(-50%);
  padding: 2px var(--w-space-3); border-radius: var(--w-radius-pill); font-size: 11px;
  /* 蓝当底托白字 —— 用 accent-bg（#2563eb, 5.17:1）；
     用 accent（#1677ff）只有 4.10:1，11px 小字不达标 */
  background: var(--w-accent-bg, #2563eb); color: #fff;
}
.price-card h3 { margin: 0 0 4px; font-size: 17px; color: var(--w-text-strong, #111827); }
.price-card .sub { font-size: 12px; color: var(--w-text-muted, #6b7280); margin: 0 0 14px; min-height: 18px; }
.amount { font-size: 34px; font-weight: 700; color: var(--w-text-strong, #0f172a); margin-bottom: 4px; }
.amount em { font-size: 18px; font-style: normal; margin-right: 2px; }
.quota {
  font-size: 13px; color: var(--w-accent-text, #0958d9);
  margin: 0 0 16px; font-weight: 500;
}
.price-card ul { list-style: none; padding: 0; margin: 0 0 20px; }
.price-card li { display: flex; align-items: flex-start; gap: var(--w-space-2); font-size: 13px; color: var(--w-text-muted, #4b5563); padding: var(--w-space-1) 0; }
.price-card li i { color: #10b981; margin-top: 2px; }

/* 评价 */
.reviews { grid-template-columns: repeat(3, 1fr); }
.review {
  padding: var(--w-space-5); border-radius: var(--w-radius-lg);
  background: var(--w-surface, #fff); border: 1px solid var(--w-border, #e5e7eb);
  box-shadow: var(--w-card-shadow, 0 6px 24px rgba(15, 23, 42, 0.07));
}
.stars { color: #f59e0b; font-size: 14px; margin-bottom: var(--w-space-3); }
.review p { font-size: 13px; line-height: 1.8; color: var(--w-text-muted, #4b5563); margin: 0 0 14px; }
.who { display: flex; align-items: center; gap: 8px; }
.avatar {
  width: 28px; height: 28px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--w-accent-soft-bg, rgba(22, 119, 255, 0.1));
  color: var(--w-accent, #1677ff); font-size: 13px; font-weight: 600;
}
.who strong { font-size: 13px; color: var(--w-text-strong, #111827); }

.faq-card {
  padding: var(--w-space-1) var(--w-space-5);
  border-radius: var(--w-radius-lg);
  background: var(--w-surface, #fff);
  border: 1px solid var(--w-border, #e5e7eb);
  box-shadow: var(--w-card-shadow, 0 6px 24px rgba(15, 23, 42, 0.07));
}
/* Element 的折叠面板内外层都是硬编码白底（不走 --el-* 变量），
   这里统一放开让卡片自己的底色透出来，日夜两套才都正常。 */
.faq-card ::v-deep .el-collapse,
.faq-card ::v-deep .el-collapse-item__header,
.faq-card ::v-deep .el-collapse-item__wrap {
  background-color: transparent;
  border-color: var(--w-border, #e5e7eb);
}
.faq-card ::v-deep .el-collapse-item__header {
  color: var(--w-text-strong, #111827);
  font-size: 14px;
  font-weight: 500;
}
.faq-card ::v-deep .el-collapse-item__header:hover { color: var(--w-accent, #1677ff); }
.faq-card ::v-deep .el-collapse-item__content {
  color: var(--w-text-muted, #4b5563);
  padding-bottom: 16px;
}
.faq-a { font-size: 13px; line-height: 1.8; color: var(--w-text-muted, #4b5563); white-space: pre-wrap; }

/* 结尾行动号召 */
.cta-band {
  padding: 64px 0;
  /* 亮端用 #2563eb：白字 5.17:1。原来 #1677ff 只有 4.10:1，
     而这一区含 15px 说明文字，属正文，需 >=4.5 */
  background: linear-gradient(135deg, #2563eb, #0e7490);
  color: #fff; text-align: center;
}
.cta-band h2 { color: #fff; margin: 0 0 8px; font-size: 28px; }
.cta-band p { margin: 0 0 24px; opacity: 0.9; font-size: 15px; }
/* 白底按钮压在深色渐变上：文字必须够深，原来 #1677ff 只有 4.10:1 */
.cta-band .el-button { background: #fff; border-color: #fff; color: #1d4ed8; font-weight: 600; }

/* 页脚 */
.foot { padding: var(--w-space-7) 0 var(--w-space-5); background: var(--w-band, rgba(255, 255, 255, 0.55)); border-top: 1px solid var(--w-border, #e5e7eb); }
.foot-cols { display: grid; grid-template-columns: 1.4fr 1fr 1fr 1fr; gap: 28px; }
.foot-brand .brand { display: flex; align-items: center; gap: var(--w-space-3); margin-bottom: var(--w-space-3); }
.foot-note { font-size: 13px; color: var(--w-text-muted, #6b7280); margin: 0; line-height: 1.7; }
.foot-col h4 { font-size: 14px; margin: 0 0 12px; color: var(--w-text-strong, #111827); }
.foot-col a, .foot-col .muted {
  display: block; font-size: 13px; color: var(--w-text-muted, #6b7280);
  text-decoration: none; margin-bottom: 8px;
}
.foot-col a:hover { color: var(--w-accent, #1677ff); }
.copyright {
  margin-top: 30px; padding-top: 16px;
  border-top: 1px solid var(--w-border, #e5e7eb);
  font-size: 12px; color: var(--w-text-muted, #9ca3af);
}

/* ---------- 响应式 ---------- */
@media (max-width: 1024px) {
  .hero-inner { grid-template-columns: 1fr; }
  .hero-art { order: -1; }
  .scenarios { grid-template-columns: repeat(2, 1fr); }
  .scene-1, .scene-2, .scene-3, .scene-4, .scene-5 { grid-column: span 1; }
  .advantages, .pricing, .reviews { grid-template-columns: repeat(2, 1fr); }
  .nav-links { display: none; }
}
/* 390px 时顶栏预算约 381px，刚好放得下；
   再窄（如 320px 的 iPhone SE）就得让位 —— 只留图标，不留换行 */
@media (max-width: 380px) {
  .brand-name { display: none; }
}
@media (max-width: 640px) {
  .hero h1 { font-size: 29px; }
  .scenarios, .advantages, .pricing, .reviews { grid-template-columns: 1fr; }
  .foot-cols { grid-template-columns: 1fr 1fr; }
  .dl-row { gap: 24px; }
}
</style>
