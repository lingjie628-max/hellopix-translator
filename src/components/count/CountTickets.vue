<template>
  <div class="count-page">
    <section class="count-hero">
      <div>
        <div class="count-kicker">COUNT DESK</div>
        <h1>计数工单</h1>
        <p>绑定客户端实际上报的接入账号后，系统按会话去重计粉。同一客户换账号再次进入，自动记为重粉。</p>
      </div>
      <el-button v-if="counterSuite" type="primary" icon="el-icon-plus" @click="openTicketForm()">新建计数工单</el-button>
    </section>

    <section v-if="!counterSuite" class="count-locked">
      <div class="count-locked-mark">PRO</div>
      <div>
        <h2>当前套餐未开通计数工单</h2>
        <p>Hello Pix 高级版可以继续使用翻译与多开；计数工单、新粉/重粉统计和自动工单需要升级专业版。</p>
      </div>
      <el-button type="primary" @click="$router.push('/user/rechargePage')">查看套餐</el-button>
    </section>

    <template v-else>
    <section class="count-panel">
      <div class="count-toolbar">
        <el-input
          v-model="filters.keyword"
          clearable
          placeholder="搜索工单名称"
          prefix-icon="el-icon-search"
          @keyup.enter.native="search"
          @clear="search"
        ></el-input>
        <el-select v-model="filters.status" clearable placeholder="全部状态" @change="search">
          <el-option label="进行中" value="active"></el-option>
          <el-option label="已关闭" value="closed"></el-option>
        </el-select>
        <el-button @click="search">查询</el-button>
        <span class="count-rule">会话去重 · 消息不重复灌水 · 跨账号识别重粉</span>
      </div>

      <el-table :data="rows" v-loading="loading" border stripe>
        <el-table-column label="工单" min-width="210">
          <template slot-scope="scope">
            <button class="count-title" type="button" @click="openDetail(scope.row)">
              <span>{{ scope.row.title }}</span>
              <small>#{{ scope.row.id }}</small>
            </button>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="92">
          <template slot-scope="scope">
            <el-tag :type="scope.row.status === 'active' ? 'success' : 'info'" size="mini">
              {{ scope.row.status === 'active' ? '进行中' : '已关闭' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="计数应用" width="145">
          <template slot-scope="scope">{{ platformName(scope.row.platform) }}</template>
        </el-table-column>
        <el-table-column prop="accountCount" label="账号" width="76" align="center"></el-table-column>
        <el-table-column label="累计进粉" width="104" align="right">
          <template slot-scope="scope"><b class="count-number">{{ scope.row.totalFans }}</b></template>
        </el-table-column>
        <el-table-column label="今日进粉" width="104" align="right">
          <template slot-scope="scope"><b class="count-number">{{ scope.row.todayFans }}</b></template>
        </el-table-column>
        <el-table-column label="累计重粉" width="104" align="right">
          <template slot-scope="scope"><b class="count-number count-repeat">{{ scope.row.repeatFans }}</b></template>
        </el-table-column>
        <el-table-column label="今日重粉" width="104" align="right">
          <template slot-scope="scope"><b class="count-number count-repeat">{{ scope.row.todayRepeatFans }}</b></template>
        </el-table-column>
        <el-table-column label="单日 / 总目标" min-width="132">
          <template slot-scope="scope">{{ scope.row.dayTarget }} / {{ scope.row.totalTarget }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template slot-scope="scope">
            <el-button type="text" @click="openDetail(scope.row)">明细</el-button>
            <el-button type="text" @click="openTicketForm(scope.row)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-empty v-if="!loading && !rows.length" description="还没有计数工单"></el-empty>
      <el-pagination
        v-if="total > filters.rows"
        class="count-pagination"
        :current-page="filters.page"
        :page-size="filters.rows"
        :total="total"
        layout="total, prev, pager, next"
        @current-change="changePage"
      ></el-pagination>
    </section>

    <el-drawer
      :visible.sync="detailVisible"
      size="82%"
      :with-header="false"
      custom-class="count-drawer"
    >
      <div v-if="ticket" v-loading="detailLoading" class="count-detail">
        <header class="count-detail-head">
          <div>
            <div class="count-kicker">TICKET #{{ ticket.id }}</div>
            <h2>{{ ticket.title }}</h2>
            <p>{{ platformName(ticket.platform) }} · 业务日从 {{ ticket.zeroTime }} 开始 · {{ ticket.timezone }}</p>
          </div>
          <div class="count-detail-actions">
            <el-tag :type="ticket.status === 'active' ? 'success' : 'info'">
              {{ ticket.status === 'active' ? '进行中' : '已关闭' }}
            </el-tag>
            <el-button icon="el-icon-edit" @click="openTicketForm(ticket)">编辑</el-button>
            <el-button type="primary" icon="el-icon-plus" :disabled="ticket.status !== 'active'" @click="openAccountForm">
              绑定账号
            </el-button>
          </div>
        </header>

        <section class="count-metrics">
          <div class="metric-card metric-primary"><span>今日进粉</span><b>{{ metrics.todayFans || 0 }}</b></div>
          <div class="metric-card"><span>今日新粉</span><b>{{ metrics.todayNewFans || 0 }}</b></div>
          <div class="metric-card metric-repeat"><span>今日重粉</span><b>{{ metrics.todayRepeatFans || 0 }}</b></div>
          <div class="metric-card"><span>累计进粉</span><b>{{ metrics.totalFans || 0 }}</b></div>
          <div class="metric-card"><span>累计新粉</span><b>{{ metrics.newFans || 0 }}</b></div>
          <div class="metric-card metric-repeat"><span>累计重粉</span><b>{{ metrics.repeatFans || 0 }}</b></div>
        </section>

        <section class="count-section">
          <div class="count-section-head">
            <div>
              <h3>绑定账号</h3>
              <p>一个客户端接入账号同时只能属于一个进行中的计数工单。</p>
            </div>
          </div>
          <el-table :data="accounts" size="small" border>
            <el-table-column label="平台" min-width="150">
              <template slot-scope="scope">{{ platformName(scope.row.platform) }}</template>
            </el-table-column>
            <el-table-column prop="accountKey" label="账号" min-width="180" show-overflow-tooltip></el-table-column>
            <el-table-column label="状态" width="82">
              <template slot-scope="scope">
                <el-tag :type="scope.row.active ? 'success' : 'info'" size="mini">
                  {{ scope.row.active ? '计数中' : '已停用' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="todayFans" label="今日" width="78" align="right"></el-table-column>
            <el-table-column prop="totalFans" label="累计" width="78" align="right"></el-table-column>
            <el-table-column prop="repeatFans" label="重粉" width="78" align="right"></el-table-column>
            <el-table-column label="操作" width="84" align="right">
              <template slot-scope="scope">
                <el-button
                  v-if="scope.row.active"
                  type="text"
                  class="count-danger"
                  @click="deactivate(scope.row)"
                >停用</el-button>
              </template>
            </el-table-column>
          </el-table>
        </section>

        <section class="count-section">
          <div class="count-section-head count-fans-head">
            <div>
              <h3>粉丝明细</h3>
              <p>一行代表一条真实会话，不会按消息条数重复计数。</p>
            </div>
            <div class="count-fan-filters">
              <el-select v-model="fanFilters.type" size="small" @change="loadFans(1)">
                <el-option label="全部" value="all"></el-option>
                <el-option label="新粉" value="new"></el-option>
                <el-option label="重粉" value="repeat"></el-option>
              </el-select>
              <el-input
                v-model="fanFilters.keyword"
                size="small"
                clearable
                placeholder="账号或昵称"
                @keyup.enter.native="loadFans(1)"
                @clear="loadFans(1)"
              ></el-input>
              <el-button size="small" @click="loadFans(1)">查询</el-button>
            </div>
          </div>
          <el-table :data="fans" size="small" border>
            <el-table-column label="类型" width="82">
              <template slot-scope="scope">
                <el-tag :type="scope.row.fanType === 'repeat' ? 'warning' : 'success'" size="mini">
                  {{ scope.row.fanType === 'repeat' ? '重粉' : '新粉' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="displayName" label="昵称" min-width="130" show-overflow-tooltip>
              <template slot-scope="scope">{{ scope.row.displayName || '—' }}</template>
            </el-table-column>
            <el-table-column prop="peerKey" label="客户标识" min-width="160" show-overflow-tooltip></el-table-column>
            <el-table-column prop="customerPublicId" label="客户编号" width="110"></el-table-column>
            <el-table-column label="平台" width="140">
              <template slot-scope="scope">{{ platformName(scope.row.platform) }}</template>
            </el-table-column>
            <el-table-column prop="accountKey" label="接入账号" min-width="150" show-overflow-tooltip></el-table-column>
            <el-table-column label="进粉时间" width="168">
              <template slot-scope="scope">{{ formatTime(scope.row.eventAt) }}</template>
            </el-table-column>
          </el-table>
          <el-empty v-if="!fans.length" description="还没有粉丝记录"></el-empty>
          <el-pagination
            v-if="fanTotal > fanFilters.rows"
            class="count-pagination"
            :current-page="fanFilters.page"
            :page-size="fanFilters.rows"
            :total="fanTotal"
            layout="total, prev, pager, next"
            @current-change="loadFans"
          ></el-pagination>
        </section>
      </div>
    </el-drawer>

    <el-dialog
      :title="ticketForm.id ? '编辑计数工单' : '新建计数工单'"
      :visible.sync="ticketDialog"
      width="520px"
      :close-on-click-modal="false"
    >
      <el-form label-width="92px">
        <el-form-item label="工单名称">
          <el-input v-model="ticketForm.title" maxlength="120" show-word-limit></el-input>
        </el-form-item>
        <el-form-item label="计数应用">
          <el-select v-model="ticketForm.platform" filterable style="width:100%">
            <el-option v-for="p in platformOptions" :key="p.id" :label="p.name" :value="p.id"></el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="ticketForm.status">
            <el-radio-button label="active">进行中</el-radio-button>
            <el-radio-button label="closed">已关闭</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="单日目标">
          <el-input-number v-model="ticketForm.dayTarget" :min="0" :max="1000000"></el-input-number>
        </el-form-item>
        <el-form-item label="总目标">
          <el-input-number v-model="ticketForm.totalTarget" :min="0" :max="1000000000"></el-input-number>
        </el-form-item>
        <el-form-item label="业务时区">
          <el-select v-model="ticketForm.timezone" filterable allow-create style="width:100%">
            <el-option v-for="z in timezones" :key="z" :label="z" :value="z"></el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="每日置零">
          <el-input v-model="ticketForm.zeroTime" placeholder="00:00:00"></el-input>
        </el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="ticketDialog = false">取消</el-button>
        <el-button type="primary" :loading="savingTicket" @click="saveTicket">保存</el-button>
      </span>
    </el-dialog>

    <el-dialog title="绑定接入账号" :visible.sync="accountDialog" width="480px" :close-on-click-modal="false">
      <el-form label-width="82px">
        <el-form-item label="平台">
          <el-input :value="platformName(ticket.platform)" disabled></el-input>
        </el-form-item>
        <el-form-item label="接入账号">
          <el-select
            v-model="accountForm.accountKey"
            filterable
            default-first-option
            style="width:100%"
            placeholder="选择客户端已上报账号"
          >
            <el-option
              v-for="item in availableAccountOptions"
              :key="item.platform + ':' + item.accountKey"
              :label="platformName(item.platform) + ' · ' + item.accountKey + '（' + item.conversationCount + ' 会话）'"
              :value="item.accountKey"
            ></el-option>
          </el-select>
        </el-form-item>
      </el-form>
      <p v-if="!availableAccountOptions.length" class="count-form-tip">
        还没有可绑定账号。请先在客户端打开该应用的一个会话，让客户端上报接入账号。
      </p>
      <p v-else class="count-form-tip">这里选择客户端主进程实际上报的接入账号；它可能不是 WhatsApp 手机号。</p>
      <span slot="footer">
        <el-button @click="accountDialog = false">取消</el-button>
        <el-button
          type="primary"
          :loading="savingAccount"
          :disabled="!accountForm.accountKey"
          @click="saveAccount"
        >绑定</el-button>
      </span>
    </el-dialog>
    </template>
  </div>
</template>

<script>
export default {
  data() {
    return {
      loading: false,
      rows: [],
      total: 0,
      filters: { keyword: '', status: '', page: 1, rows: 30 },
      detailVisible: false,
      detailLoading: false,
      ticket: null,
      metrics: {},
      accounts: [],
      fans: [],
      fanTotal: 0,
      fanFilters: { type: 'all', keyword: '', page: 1, rows: 20 },
      platforms: [],
      ticketDialog: false,
      savingTicket: false,
      ticketForm: {},
      accountDialog: false,
      savingAccount: false,
      accountForm: { platform: 'whatsapp-green', accountKey: '' },
      availableAccounts: [],
      timezones: [
        'Asia/Shanghai',
        'Asia/Hong_Kong',
        'Asia/Singapore',
        'Asia/Kuala_Lumpur',
        'Asia/Bangkok',
        'Asia/Jakarta',
        'Asia/Manila',
        'Asia/Tokyo',
        'America/New_York',
        'America/Los_Angeles',
        'Europe/London',
        'UTC'
      ]
    }
  },
  computed: {
    counterSuite() {
      const user = this.$store.state.user || {}
      return user.counterSuite === true || Number(user.counterSuite) === 1
    },
    platformOptions() {
      return this.platforms.length ? this.platforms : [{ id: 'whatsapp-green', name: 'WhatsApp绿色版' }]
    },
    availableAccountOptions() {
      return this.availableAccounts.filter(item => item.platform === this.accountForm.platform)
    }
  },
  mounted() {
    this.getRequest('/client/platforms').then(resp => {
      if (resp && resp.data && Array.isArray(resp.data.rows)) this.platforms = resp.data.rows
    }).catch(() => {})
  },
  activated() {
    if (this.counterSuite) this.load()
  },
  methods: {
    load() {
      this.loading = true
      this.getRequest('/count-tickets', this.filters).then(resp => {
        this.loading = false
        if (resp && resp.status === 200) {
          this.rows = resp.data.rows || []
          this.total = Number(resp.data.total) || 0
        }
      }).catch(() => { this.loading = false })
    },
    search() {
      this.filters.page = 1
      this.load()
    },
    changePage(page) {
      this.filters.page = page
      this.load()
    },
    openDetail(row) {
      this.detailVisible = true
      this.detailLoading = true
      this.ticket = Object.assign({}, row)
      this.fanFilters.page = 1
      this.getRequest(`/count-tickets/${row.id}`).then(resp => {
        if (resp && resp.status === 200) {
          this.ticket = resp.data.ticket
          this.metrics = resp.data.metrics || {}
          this.accounts = resp.data.accounts || []
          this.loadFans(1)
        }
      }).finally(() => { this.detailLoading = false })
    },
    loadFans(page) {
      if (!this.ticket) return
      this.fanFilters.page = page || this.fanFilters.page
      const params = Object.assign({}, this.fanFilters, { rows: 20 })
      this.getRequest(`/count-tickets/${this.ticket.id}/fans`, params).then(resp => {
        if (resp && resp.status === 200) {
          this.fans = resp.data.rows || []
          this.fanTotal = Number(resp.data.total) || 0
        }
      }).catch(() => {})
    },
    openTicketForm(row) {
      const source = row || {}
      this.ticketForm = {
        id: source.id || null,
        title: source.title || '',
        platform: source.platform || (this.platforms[0] && this.platforms[0].id) || 'whatsapp-green',
        status: source.status || 'active',
        dayTarget: Number(source.dayTarget) || 0,
        totalTarget: Number(source.totalTarget) || 0,
        timezone: source.timezone || 'Asia/Shanghai',
        zeroTime: source.zeroTime || '00:00:00'
      }
      this.ticketDialog = true
    },
    saveTicket() {
      if (!String(this.ticketForm.title || '').trim()) {
        this.$message.warning('请填写工单名称')
        return
      }
      this.savingTicket = true
      this.postRequest('/count-tickets/save', this.ticketForm).then(resp => {
        this.savingTicket = false
        if (resp && resp.data && resp.data.success === 'success') {
          this.$message.success(resp.data.msg)
          const id = resp.data.id
          this.ticketDialog = false
          this.load()
          if (this.detailVisible && id) {
            this.openDetail({ id })
          }
        }
      }).catch(() => { this.savingTicket = false })
    },
    openAccountForm() {
      this.accountForm = { platform: this.ticket.platform, accountKey: '' }
      this.accountDialog = true
      this.getRequest('/count-tickets/available-accounts', {
        ticketId: this.ticket.id
      }).then(resp => {
        if (resp && resp.data && Array.isArray(resp.data.rows)) {
          this.availableAccounts = resp.data.rows
          if (this.availableAccounts.length) {
            const first = this.availableAccounts[0]
            this.accountForm.accountKey = first.accountKey
          }
        }
      }).catch(() => {})
    },
    saveAccount() {
      if (!String(this.accountForm.accountKey || '').trim()) {
        this.$message.warning('请选择或填写接入账号')
        return
      }
      this.savingAccount = true
      this.postRequest('/count-tickets/accounts/save', Object.assign({
        ticketId: this.ticket.id
      }, this.accountForm)).then(resp => {
        this.savingAccount = false
        if (resp && resp.data && resp.data.success === 'success') {
          this.$message.success(resp.data.msg)
          this.accountDialog = false
          this.openDetail({ id: this.ticket.id })
        }
      }).catch(() => { this.savingAccount = false })
    },
    deactivate(row) {
      this.$confirm(`停用账号 ${row.accountKey} 后，新会话将不再计入本工单。`, '停用计数账号', {
        type: 'warning'
      }).then(() => this.postRequest('/count-tickets/accounts/remove', {
        ticketId: this.ticket.id,
        platform: row.platform,
        accountKey: row.accountKey
      })).then(resp => {
        if (resp && resp.data && resp.data.success === 'success') {
          this.$message.success(resp.data.msg)
          this.openDetail({ id: this.ticket.id })
        }
      }).catch(() => {})
    },
    platformName(id) {
      const found = this.platforms.find(item => item.id === id)
      return found ? found.name : id
    },
    formatTime(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      const p = n => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`
    }
  }
}
</script>

<style scoped>
.count-page {
  --count-ink: #17212b;
  --count-muted: #637083;
  --count-line: #dfe5ec;
  --count-paper: #fbfaf6;
  --count-blue: #0f4c81;
  --count-blue-soft: #e8f1f8;
  --count-amber: #a55612;
  --count-amber-soft: #fff2dd;
  color: var(--count-ink);
  text-align: left;
}
.count-hero {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding: 26px 30px;
  margin-bottom: 14px;
  color: #f8f4ea;
  background:
    linear-gradient(115deg, rgba(255,255,255,.07) 0 1px, transparent 1px 26px),
    linear-gradient(145deg, #152536, #0f4c81);
  border-radius: 16px;
  box-shadow: 0 16px 36px rgba(15, 76, 129, .18);
}
.count-hero h1,
.count-detail h2 {
  margin: 4px 0 7px;
  font-family: "STSong", "Songti SC", serif;
  font-size: 30px;
  letter-spacing: .04em;
}
.count-hero p,
.count-detail-head p {
  margin: 0;
  max-width: 680px;
  color: rgba(255,255,255,.72);
  line-height: 1.7;
}
.count-kicker {
  color: #eab66e;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .2em;
}
.count-locked {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 30px;
  border: 1px solid #ecd9b7;
  border-radius: 16px;
  background: linear-gradient(135deg, #fffaf1, #f7f1e7);
  box-shadow: 0 12px 30px rgba(94, 69, 30, .08);
}
.count-locked-mark {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 58px;
  height: 58px;
  border-radius: 16px;
  color: #fff;
  background: #a55612;
  font: 700 18px/1 "STSong", "Songti SC", serif;
  letter-spacing: .08em;
}
.count-locked h2 {
  margin: 0 0 7px;
  color: #5f380d;
  font-family: "STSong", "Songti SC", serif;
}
.count-locked p {
  flex: 1;
  margin: 0;
  color: #745d3f;
  line-height: 1.7;
}
.count-panel,
.count-section {
  background: var(--count-paper);
  border: 1px solid var(--count-line);
  border-radius: 14px;
}
.count-panel { padding: 16px; }
.count-toolbar,
.count-fan-filters,
.count-detail-actions,
.count-section-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.count-toolbar { margin-bottom: 14px; }
.count-toolbar .el-input { width: 260px; }
.count-toolbar .el-select { width: 130px; }
.count-rule {
  margin-left: auto;
  color: var(--count-muted);
  font-size: 12px;
}
.count-title {
  padding: 0;
  border: 0;
  color: var(--count-ink);
  background: transparent;
  font: inherit;
  font-weight: 650;
  text-align: left;
  cursor: pointer;
}
.count-title:hover { color: var(--count-blue); }
.count-title small {
  display: block;
  margin-top: 4px;
  color: var(--count-muted);
  font-weight: 400;
}
.count-number {
  font-variant-numeric: tabular-nums;
  font-size: 16px;
}
.count-repeat { color: var(--count-amber); }
.count-pagination { margin-top: 14px; text-align: right; }
.count-detail { padding: 22px; }
.count-detail-head {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: flex-start;
  padding: 22px 24px;
  color: #f8f4ea;
  background: linear-gradient(135deg, #152536, #234f70);
  border-radius: 14px;
}
.count-detail-head h2 { font-size: 28px; }
.count-metrics {
  display: grid;
  grid-template-columns: repeat(6, minmax(120px, 1fr));
  gap: 10px;
  margin: 14px 0;
}
.metric-card {
  padding: 16px;
  background: var(--count-paper);
  border: 1px solid var(--count-line);
  border-left: 4px solid #9aa9b9;
  border-radius: 12px;
}
.metric-card span {
  display: block;
  color: var(--count-muted);
  font-size: 12px;
}
.metric-card b {
  display: block;
  margin-top: 8px;
  font: 700 26px/1.1 "Avenir Next Condensed", "DIN Alternate", sans-serif;
  font-variant-numeric: tabular-nums;
}
.metric-primary { border-left-color: var(--count-blue); background: var(--count-blue-soft); }
.metric-repeat { border-left-color: var(--count-amber); background: var(--count-amber-soft); }
.count-section { padding: 18px; margin-top: 14px; }
.count-section-head { justify-content: space-between; margin-bottom: 12px; }
.count-section-head h3 { margin: 0 0 4px; font-size: 17px; }
.count-section-head p { margin: 0; color: var(--count-muted); font-size: 12px; }
.count-fan-filters .el-input { width: 180px; }
.count-fan-filters .el-select { width: 96px; }
.count-danger { color: #b42318; }
.count-form-tip {
  margin: 0;
  color: var(--count-muted);
  font-size: 12px;
  line-height: 1.7;
}
@media (max-width: 1100px) {
  .count-metrics { grid-template-columns: repeat(3, minmax(120px, 1fr)); }
  .count-rule { display: none; }
}
@media (max-width: 720px) {
  .count-hero,
  .count-detail-head,
  .count-section-head { align-items: stretch; flex-direction: column; }
  .count-metrics { grid-template-columns: repeat(2, minmax(110px, 1fr)); }
  .count-toolbar,
  .count-fan-filters { flex-wrap: wrap; }
}
@media (prefers-reduced-motion: reduce) {
  .count-page * { transition: none !important; animation: none !important; }
}
</style>
