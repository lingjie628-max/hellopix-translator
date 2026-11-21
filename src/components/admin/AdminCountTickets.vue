<template>
  <div class="admin-page count-admin">
    <div class="admin-bar">
      <el-input
        v-model="filters.keyword"
        clearable
        placeholder="工单名称 / 商户"
        style="width:260px"
        @keyup.enter.native="search"
        @clear="search"
      ></el-input>
      <el-select v-model="filters.status" clearable placeholder="全部状态" style="width:130px" @change="search">
        <el-option label="进行中" value="active"></el-option>
        <el-option label="已关闭" value="closed"></el-option>
      </el-select>
      <el-button type="primary" @click="search">查询</el-button>
      <span class="admin-hint">只读视图；账号绑定与工单归属由商户维护</span>
    </div>

    <el-table :data="rows" v-loading="loading" border stripe>
      <el-table-column prop="id" label="工单号" width="90"></el-table-column>
      <el-table-column prop="username" label="商户" width="130"></el-table-column>
      <el-table-column prop="title" label="工单名称" min-width="180" show-overflow-tooltip></el-table-column>
      <el-table-column prop="platform" label="计数应用" width="130"></el-table-column>
      <el-table-column label="查重范围" width="128">
        <template slot-scope="scope">{{ scopeLabel(scope.row.dedupScope) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template slot-scope="scope">
          <el-tag :type="scope.row.status === 'active' ? 'success' : 'info'" size="mini">
            {{ scope.row.status === 'active' ? '进行中' : '已关闭' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="accountCount" label="账号" width="76" align="center"></el-table-column>
      <el-table-column prop="todayFans" label="今日" width="82" align="right"></el-table-column>
      <el-table-column prop="totalFans" label="累计" width="82" align="right"></el-table-column>
      <el-table-column prop="todayRepeatFans" label="今日重粉" width="96" align="right"></el-table-column>
      <el-table-column prop="repeatFans" label="累计重粉" width="96" align="right"></el-table-column>
      <el-table-column label="更新时间" width="168">
        <template slot-scope="scope">{{ formatTime(scope.row.updatedAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="86">
        <template slot-scope="scope">
          <el-button type="text" @click="open(scope.row)">查看</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-if="total > filters.rows"
      style="margin-top:12px"
      :current-page="filters.page"
      :page-size="filters.rows"
      :total="total"
      layout="total, prev, pager, next"
      @current-change="changePage"
    ></el-pagination>

    <el-drawer :visible.sync="visible" size="78%" :with-header="false">
      <div v-if="ticket" v-loading="detailLoading" class="admin-count-detail">
        <div class="admin-count-head">
          <div>
            <small>COUNT TICKET #{{ ticket.id }}</small>
            <h2>{{ ticket.title }}</h2>
            <p>
              {{ ticket.platform }} · {{ scopeLabel(ticket.dedupScope) }} · {{ ticket.username }}
              · {{ ticket.timezone }} · 每日 {{ ticket.zeroTime }} 置零
            </p>
          </div>
          <el-button @click="visible = false">关闭</el-button>
        </div>

        <div class="admin-count-metrics">
          <div><span>今日进粉</span><b>{{ metrics.todayFans || 0 }}</b></div>
          <div><span>今日新粉</span><b>{{ metrics.todayNewFans || 0 }}</b></div>
          <div><span>今日重粉</span><b class="repeat">{{ metrics.todayRepeatFans || 0 }}</b></div>
          <div><span>累计进粉</span><b>{{ metrics.totalFans || 0 }}</b></div>
          <div><span>累计新粉</span><b>{{ metrics.newFans || 0 }}</b></div>
          <div><span>累计重粉</span><b class="repeat">{{ metrics.repeatFans || 0 }}</b></div>
        </div>

        <el-card shadow="never" class="admin-count-card">
          <div slot="header">账号统计</div>
          <el-table :data="accounts" size="small" border>
            <el-table-column prop="platform" label="平台" width="150"></el-table-column>
            <el-table-column prop="accountKey" label="账号" min-width="180" show-overflow-tooltip></el-table-column>
            <el-table-column label="状态" width="86">
              <template slot-scope="scope">{{ scope.row.active ? '计数中' : '已停用' }}</template>
            </el-table-column>
            <el-table-column prop="todayFans" label="今日" width="82" align="right"></el-table-column>
            <el-table-column prop="totalFans" label="累计" width="82" align="right"></el-table-column>
            <el-table-column prop="repeatFans" label="重粉" width="82" align="right"></el-table-column>
          </el-table>
        </el-card>

        <el-card shadow="never" class="admin-count-card">
          <div slot="header" class="fan-head">
            <span>粉丝明细</span>
            <span class="fan-filters">
              <el-select v-model="fanFilters.type" size="mini" @change="loadFans(1)">
                <el-option label="全部" value="all"></el-option>
                <el-option label="新粉" value="new"></el-option>
                <el-option label="重粉" value="repeat"></el-option>
              </el-select>
              <el-input
                v-model="fanFilters.keyword"
                size="mini"
                clearable
                placeholder="账号 / 昵称"
                @keyup.enter.native="loadFans(1)"
                @clear="loadFans(1)"
              ></el-input>
              <el-button size="mini" @click="loadFans(1)">查询</el-button>
            </span>
          </div>
          <el-table :data="fans" size="small" border>
            <el-table-column label="类型" width="82">
              <template slot-scope="scope">
                <el-tag :type="scope.row.fanType === 'repeat' ? 'warning' : 'success'" size="mini">
                  {{ scope.row.fanType === 'repeat' ? '重粉' : '新粉' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="displayName" label="昵称" min-width="120" show-overflow-tooltip></el-table-column>
            <el-table-column prop="peerKey" label="客户标识" min-width="150" show-overflow-tooltip></el-table-column>
            <el-table-column prop="customerPublicId" label="客户编号" width="110"></el-table-column>
            <el-table-column prop="platform" label="平台" width="140"></el-table-column>
            <el-table-column prop="accountKey" label="接入账号" min-width="160" show-overflow-tooltip></el-table-column>
            <el-table-column label="进粉时间" width="168">
              <template slot-scope="scope">{{ formatTime(scope.row.eventAt) }}</template>
            </el-table-column>
          </el-table>
          <el-pagination
            v-if="fanTotal > fanFilters.rows"
            style="margin-top:12px;text-align:right"
            :current-page="fanFilters.page"
            :page-size="fanFilters.rows"
            :total="fanTotal"
            layout="total, prev, pager, next"
            @current-change="loadFans"
          ></el-pagination>
        </el-card>
      </div>
    </el-drawer>
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
      visible: false,
      detailLoading: false,
      ticket: null,
      metrics: {},
      accounts: [],
      fans: [],
      fanTotal: 0,
      fanFilters: { type: 'all', keyword: '', page: 1, rows: 20 }
    }
  },
  mounted() { this.load() },
  methods: {
    load() {
      this.loading = true
      this.getRequest('/admin/count-tickets', this.filters).then(resp => {
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
    open(row) {
      this.visible = true
      this.detailLoading = true
      this.ticket = Object.assign({}, row)
      this.getRequest(`/admin/count-tickets/${row.id}`).then(resp => {
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
      this.getRequest(`/admin/count-tickets/${this.ticket.id}/fans`,
        Object.assign({}, this.fanFilters, { rows: 20 })).then(resp => {
        if (resp && resp.status === 200) {
          this.fans = resp.data.rows || []
          this.fanTotal = Number(resp.data.total) || 0
        }
      }).catch(() => {})
    },
    scopeLabel(scope) {
      if (scope === 'ticket') return '仅当前工单'
      if (scope === 'linked') return '指定关联工单'
      return '同商户全部工单'
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
.count-admin { text-align: left; }
.admin-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.admin-hint { margin-left: auto; color: var(--w-text-faint); font-size: 12px; }
.admin-count-detail { padding: 22px; text-align: left; }
.admin-count-head {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding: 22px;
  color: #f8f4ea;
  background: linear-gradient(135deg, #17212b, #2e5267);
  border-radius: 14px;
}
.admin-count-head small { color: #eab66e; letter-spacing: .16em; }
.admin-count-head h2 { margin: 8px 0 6px; font: 700 28px "STSong", "Songti SC", serif; }
.admin-count-head p { margin: 0; color: rgba(255,255,255,.7); }
.admin-count-metrics {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 10px;
  margin: 14px 0;
}
.admin-count-metrics div {
  padding: 14px;
  background: var(--w-surface);
  border: 1px solid var(--w-border);
  border-radius: 12px;
}
.admin-count-metrics span { display: block; color: var(--w-text-faint); font-size: 12px; }
.admin-count-metrics b {
  display: block;
  margin-top: 6px;
  font: 700 24px "Avenir Next Condensed", "DIN Alternate", sans-serif;
}
.admin-count-metrics .repeat { color: #a55612; }
.admin-count-card { margin-top: 14px; }
.fan-head { display: flex; justify-content: space-between; align-items: center; gap: 14px; }
.fan-filters { display: flex; gap: 8px; }
.fan-filters .el-input { width: 170px; }
@media (max-width: 900px) {
  .admin-count-metrics { grid-template-columns: repeat(3, 1fr); }
  .admin-hint { display: none; }
}
</style>
