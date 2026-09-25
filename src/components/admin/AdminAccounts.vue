<template>
  <div class="admin-page">
    <div class="admin-bar">
      <el-input v-model="keyword" placeholder="商户 / 接入账号 / 客户 / 昵称" style="width: 260px" clearable
                @keyup.enter.native="search"></el-input>
      <el-select v-model="online" placeholder="在线状态" clearable style="width: 130px">
        <el-option label="在线" value="1"></el-option>
        <el-option label="离线" value="0"></el-option>
      </el-select>
      <el-button type="primary" @click="search">搜索</el-button>
      <span class="admin-hint">「在线」= 最近 {{ windowMinutes }} 分钟内有会话活动</span>
    </div>
    <el-table :data="rows" v-loading="loading" border stripe>
      <el-table-column prop="username" label="商户" width="120"></el-table-column>
      <el-table-column prop="platform" label="平台" width="130"></el-table-column>
      <el-table-column prop="account" label="接入账号" width="120" show-overflow-tooltip></el-table-column>
      <el-table-column prop="peerKey" label="客户标识" width="150" show-overflow-tooltip></el-table-column>
      <el-table-column prop="nickName" label="昵称" width="140" show-overflow-tooltip></el-table-column>
      <el-table-column label="在线" width="80">
        <template slot-scope="scope">
          <el-tag :type="scope.row.onlineStatus === 1 ? 'success' : 'info'" size="mini">
            {{ scope.row.onlineStatus === 1 ? '在线' : '离线' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="归属" width="110">
        <template slot-scope="scope">
          <span v-if="scope.row.ownerStatus">{{ ownerText(scope.row.ownerStatus) }}</span>
          <span v-else class="admin-muted">—</span>
        </template>
      </el-table-column>
      <el-table-column prop="customerNo" label="客户编号" width="100"></el-table-column>
      <el-table-column label="最后活动" width="170">
        <template slot-scope="scope">
          <span v-if="scope.row.lastMessageAt">{{ scope.row.lastMessageAt | formatDateTime }}</span>
          <span v-else class="admin-muted">从未</span>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination style="margin-top:12px" :current-page="page" :page-size="size" :total="total"
                   layout="total, prev, pager, next" @current-change="onPage"></el-pagination>
  </div>
</template>
<script>
/**
 * 在线账号。
 *
 * 这一页展示的是**客户端真实上报的会话** —— 哪个商户、用哪个平台账号、
 * 正在跟哪个客户打交道、多久没动过。
 *
 * 它曾经查的是旧「工单」模型的 order_details 表（工单号/主号/端口/当日进粉），
 * 那套模型在当前产品里已经不存在，生产库该表一行数据都没有，接口直接返回
 * 503「该兼容模块尚未迁移到 PostgreSQL」。现在改为读 conversations。
 *
 * 「在线」的判定：会话的 last_message_at 距今是否在窗口内。客户端切换会话时
 * 会更新它，所以它衡量的是「这个客户最近被动过」，而不是账号的登录态 ——
 * 账号登录态在客户端本地，服务端看不到，不要在这里假装能看到。
 */
export default {
  data() {
    return { keyword: '', online: '', loading: false, rows: [], page: 1, size: 10, total: 0, windowMinutes: 10 }
  },
  mounted() { this.load() },
  methods: {
    search() { this.page = 1; this.load() },
    ownerText(status) {
      const table = { FOLLOWING: '跟进中', RELEASED: '已释放', COLLISION: '撞单' }
      return table[status] || status
    },
    load() {
      this.loading = true
      this.getRequest('/admin/accounts', {
        page: this.page, rows: this.size, keyword: this.keyword, online: this.online
      }).then(resp => {
        this.loading = false
        if (resp && resp.status == 200) {
          this.rows = resp.data.rows
          this.total = resp.data.total
        }
      }).catch(() => { this.loading = false })
    },
    onPage(page) { this.page = page; this.load() }
  }
}
</script>
<style scoped>
.admin-page { text-align: left; }
.admin-bar { margin-bottom: 12px; }
.admin-hint { margin-left: 12px; color: #909399; font-size: 12px; }
.admin-muted { color: #c0c4cc; }
</style>
