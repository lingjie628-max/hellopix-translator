<template>
  <div class="count-share-page">
    <main class="count-share-shell">
      <header class="count-share-head">
        <div>
          <span class="count-share-kicker">HELLO PIX · 只读对账</span>
          <h1>{{ payload && payload.ticket ? payload.ticket.title : '计数工单分享' }}</h1>
          <p v-if="payload && payload.ticket">
            {{ platformName(payload.ticket.platform) }} · 第 {{ payload.ticket.cycleNo }} 周期
            · 业务日 {{ payload.ticket.zeroTime }} 切换
          </p>
          <p v-else>输入分享密码后查看进粉、新粉与重粉数据。</p>
        </div>
        <div class="count-share-actions">
          <el-button v-if="unlocked" size="small" icon="el-icon-refresh" @click="load(password)">刷新</el-button>
          <el-button v-if="unlocked" size="small" icon="el-icon-printer" @click="printPage">打印 / 存 PDF</el-button>
        </div>
      </header>

      <section v-if="!unlocked" class="count-share-lock">
        <div class="count-share-lock-mark">LOCK</div>
        <h2>请输入分享密码</h2>
        <p>分享链接可以转给粉商核对数据，但密码不会出现在链接里。</p>
        <form @submit.prevent="unlock">
          <el-input
            v-model="password"
            type="password"
            show-password
            autocomplete="current-password"
            placeholder="分享密码"
            prefix-icon="el-icon-lock"
            @keyup.enter.native="unlock"
          ></el-input>
          <el-button type="primary" native-type="submit" :loading="loading">进入对账页</el-button>
        </form>
        <span v-if="error" class="count-share-error">{{ error }}</span>
      </section>

      <template v-else>
        <section class="count-share-metrics">
          <div class="metric-card metric-main">
            <span>本周期进粉</span>
            <b>{{ metrics.totalFans || 0 }}</b>
          </div>
          <div class="metric-card">
            <span>本周期新粉</span>
            <b>{{ metrics.newFans || 0 }}</b>
          </div>
          <div class="metric-card metric-repeat">
            <span>本周期重粉</span>
            <b>{{ metrics.repeatFans || 0 }}</b>
          </div>
          <div class="metric-card">
            <span>今日进粉</span>
            <b>{{ metrics.todayFans || 0 }}</b>
          </div>
          <div class="metric-card metric-repeat">
            <span>今日重粉</span>
            <b>{{ metrics.todayRepeatFans || 0 }}</b>
          </div>
          <div class="metric-card metric-base">
            <span>今日疑似老粉</span>
            <b>{{ metrics.todayBaseRepeatFans || 0 }}</b>
          </div>
        </section>

        <section class="count-share-card">
          <div class="count-share-section-head">
            <div>
              <h2>接粉账号</h2>
              <p>账号通过“今日 / 本周期 / 重粉”拆分，方便逐号核对。</p>
            </div>
            <span class="count-share-sync">每次刷新实时读取</span>
          </div>
          <el-table :data="payload.accounts || []" size="small" border>
            <el-table-column label="账号" min-width="190" show-overflow-tooltip>
              <template slot-scope="scope">
                <b>{{ scope.row.accountKey }}</b>
                <small class="account-state">{{ scope.row.active ? '计数中' : '已停用' }}</small>
              </template>
            </el-table-column>
            <el-table-column prop="todayFans" label="今日进粉" width="100" align="right"></el-table-column>
            <el-table-column prop="totalFans" label="本周期" width="96" align="right"></el-table-column>
            <el-table-column prop="todayRepeatFans" label="今日重粉" width="96" align="right"></el-table-column>
            <el-table-column prop="repeatFans" label="本周期重粉" width="108" align="right"></el-table-column>
          </el-table>
        </section>

        <section class="count-share-card">
          <div class="count-share-section-head count-share-fans-head">
            <div>
              <h2>粉丝明细</h2>
              <p>一行一条真实会话；同一会话刷消息不会重复计数。</p>
            </div>
            <div class="count-share-filters">
              <el-select v-model="filters.type" size="small" @change="changeType">
                <el-option label="全部" value="all"></el-option>
                <el-option label="新粉" value="new"></el-option>
                <el-option label="重粉" value="repeat"></el-option>
              </el-select>
              <el-input
                v-model="filters.keyword"
                size="small"
                clearable
                placeholder="账号或昵称"
                @keyup.enter.native="load(password)"
                @clear="load(password)"
              ></el-input>
              <el-button size="small" @click="load(password)">查询</el-button>
            </div>
          </div>
          <el-table :data="payload.fans || []" size="small" border>
            <el-table-column label="类型" width="82">
              <template slot-scope="scope">
                <el-tag :type="scope.row.fanType === 'repeat' ? 'warning' : 'success'" size="mini">
                  {{ scope.row.fanType === 'repeat' ? '重粉' : '新粉' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="依据" width="82">
              <template slot-scope="scope">
                {{ scope.row.fanType === 'repeat' ? (scope.row.repeatType === 'base' ? '底库' : '进线') : '—' }}
              </template>
            </el-table-column>
            <el-table-column prop="displayName" label="昵称" min-width="130" show-overflow-tooltip></el-table-column>
            <el-table-column prop="peerKey" label="客户标识" min-width="160" show-overflow-tooltip></el-table-column>
            <el-table-column prop="accountKey" label="接粉账号" min-width="160" show-overflow-tooltip></el-table-column>
            <el-table-column label="进粉时间" width="168">
              <template slot-scope="scope">{{ formatTime(scope.row.eventAt) }}</template>
            </el-table-column>
          </el-table>
          <el-empty v-if="!(payload.fans || []).length" description="当前周期还没有粉丝记录"></el-empty>
          <el-pagination
            v-if="payload.total > filters.rows"
            class="count-share-pagination"
            :current-page="filters.page"
            :page-size="filters.rows"
            :total="payload.total"
            layout="total, prev, pager, next"
            @current-change="changePage"
          ></el-pagination>
        </section>

        <footer class="count-share-foot">
          <span>数据仅用于商户与渠道双方对账</span>
          <span v-if="payload.share && payload.share.expiresAt">
            链接到期：{{ formatTime(payload.share.expiresAt) }}
          </span>
        </footer>
      </template>
    </main>
  </div>
</template>

<script>
export default {
  name: 'CountShare',
  data() {
    return {
      password: '',
      loading: false,
      unlocked: false,
      error: '',
      payload: {},
      filters: { type: 'all', keyword: '', page: 1, rows: 30 }
    }
  },
  computed: {
    token() {
      return this.$route.params.token || ''
    },
    metrics() {
      return (this.payload && this.payload.metrics) || {}
    }
  },
  mounted() {
    this.load('')
  },
  methods: {
    async load(password) {
      if (!this.token) {
        this.error = '分享链接缺少访问凭证'
        return
      }
      this.loading = true
      this.error = ''
      try {
        const resp = await this.postRequest('/public/count-ticket-shares/view', {
          token: this.token,
          password: password || '',
          type: this.filters.type,
          keyword: this.filters.keyword,
          page: this.filters.page,
          rows: this.filters.rows
        }, { silent: true })
        this.payload = (resp && resp.data) || {}
        this.unlocked = true
      } catch (error) {
        const body = (error && error.response && error.response.data) || {}
        this.unlocked = false
        if (body.code === 'COUNT_SHARE_PASSWORD_BAD' || !password) {
          this.error = password ? '分享密码不正确' : ''
        } else {
          this.error = body.msg || '分享链接无法打开'
        }
      } finally {
        this.loading = false
      }
    },
    unlock() {
      if (!this.password) {
        this.error = '请输入分享密码'
        return
      }
      this.load(this.password)
    },
    changeType() {
      this.filters.page = 1
      this.load(this.password)
    },
    changePage(page) {
      this.filters.page = page
      this.load(this.password)
    },
    printPage() {
      window.print()
    },
    platformName(id) {
      const names = {
        'whatsapp-green': 'WhatsApp',
        'whatsapp-pro': 'WhatsApp',
        'whatsapp-biz': 'WhatsApp Business',
        'telegram-z': 'Telegram',
        line: 'LINE',
        'line-biz': 'LINE Business',
        zalo: 'Zalo',
        signal: 'Signal'
      }
      return names[id] || id
    },
    formatTime(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      const p = number => String(number).padStart(2, '0')
      return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`
    }
  }
}
</script>

<style scoped>
.count-share-page {
  --share-ink: #14202b;
  --share-muted: #687588;
  --share-line: #dce4ec;
  --share-paper: #f6f1e8;
  --share-blue: #0c4c7f;
  --share-amber: #a6530f;
  min-height: 100vh;
  padding: 28px;
  color: var(--share-ink);
  background:
    radial-gradient(circle at 12% 0%, rgba(181, 214, 235, .62), transparent 36%),
    linear-gradient(150deg, #eef4f7 0%, var(--share-paper) 58%, #e8eee9 100%);
  text-align: left;
}
.count-share-shell {
  width: min(1180px, 100%);
  margin: 0 auto;
}
.count-share-head {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  padding: 28px 30px;
  color: #f8f4ea;
  border-radius: 18px;
  background:
    linear-gradient(115deg, rgba(255,255,255,.08) 0 1px, transparent 1px 28px),
    linear-gradient(145deg, #15283a, var(--share-blue));
  box-shadow: 0 20px 46px rgba(12, 76, 127, .2);
}
.count-share-kicker {
  font-size: 11px;
  letter-spacing: .18em;
  color: #bfd8ea;
}
.count-share-head h1 {
  margin: 7px 0;
  font-family: "Songti SC", "STSong", serif;
  font-size: clamp(28px, 4vw, 42px);
}
.count-share-head p {
  margin: 0;
  color: #dce8ef;
}
.count-share-actions {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.count-share-lock {
  max-width: 520px;
  margin: 70px auto;
  padding: 34px;
  background: rgba(255,255,255,.86);
  border: 1px solid rgba(255,255,255,.92);
  border-radius: 18px;
  box-shadow: 0 24px 60px rgba(37, 56, 69, .12);
}
.count-share-lock-mark {
  display: inline-flex;
  padding: 5px 9px;
  color: var(--share-blue);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .16em;
  border: 1px solid #b8cedd;
  border-radius: 999px;
}
.count-share-lock h2 {
  margin: 16px 0 8px;
  font-family: "Songti SC", "STSong", serif;
  font-size: 28px;
}
.count-share-lock p {
  margin: 0 0 22px;
  color: var(--share-muted);
  line-height: 1.7;
}
.count-share-lock form {
  display: flex;
  gap: 10px;
}
.count-share-error {
  display: block;
  margin-top: 12px;
  color: #b42318;
}
.count-share-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin: 16px 0;
}
.metric-card {
  padding: 20px;
  background: rgba(255,255,255,.82);
  border: 1px solid rgba(255,255,255,.92);
  border-radius: 14px;
  box-shadow: 0 10px 26px rgba(43, 62, 72, .07);
}
.metric-card span {
  color: var(--share-muted);
  font-size: 12px;
}
.metric-card b {
  display: block;
  margin-top: 8px;
  font-family: "Avenir Next", "DIN Alternate", sans-serif;
  font-size: 34px;
  line-height: 1;
}
.metric-main {
  color: #f8f4ea;
  background: linear-gradient(140deg, #18364c, #0c4c7f);
}
.metric-main span {
  color: #c7ddeb;
}
.metric-repeat b {
  color: var(--share-amber);
}
.metric-base {
  border-color: #c8d8e2;
  background: #edf4f6;
}
.metric-base b {
  color: #315f78;
}
.count-share-card {
  margin-top: 16px;
  padding: 22px;
  background: rgba(255,255,255,.88);
  border: 1px solid rgba(255,255,255,.95);
  border-radius: 16px;
  box-shadow: 0 12px 32px rgba(38, 56, 67, .08);
}
.count-share-section-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 14px;
}
.count-share-section-head h2 {
  margin: 0 0 4px;
  font-family: "Songti SC", "STSong", serif;
  font-size: 23px;
}
.count-share-section-head p {
  margin: 0;
  color: var(--share-muted);
}
.count-share-sync {
  color: #527289;
  font-size: 12px;
}
.account-state {
  margin-left: 8px;
  color: var(--share-muted);
}
.count-share-filters {
  display: flex;
  gap: 8px;
  width: min(470px, 100%);
}
.count-share-pagination {
  margin-top: 14px;
  text-align: right;
}
.count-share-foot {
  display: flex;
  justify-content: space-between;
  padding: 18px 4px 40px;
  color: var(--share-muted);
  font-size: 12px;
}
@media (max-width: 900px) {
  .count-share-page { padding: 14px; }
  .count-share-head,
  .count-share-section-head,
  .count-share-fans-head {
    flex-direction: column;
    align-items: stretch;
  }
  .count-share-metrics { grid-template-columns: repeat(2, 1fr); }
  .count-share-filters { flex-wrap: wrap; }
}
@media print {
  .count-share-page { padding: 0; background: #fff; }
  .count-share-head { color: #111; background: #fff; box-shadow: none; border-bottom: 2px solid #111; }
  .count-share-actions { display: none; }
  .count-share-card, .metric-card { box-shadow: none; break-inside: avoid; }
}
</style>
