<template>
  <div class="admin-page">
    <div class="admin-bar">
      <el-input v-model="keyword" placeholder="商户 / 接入账号 / 客户 / 昵称" style="width: 260px" clearable
                @keyup.enter.native="search"></el-input>
      <el-select v-model="type" placeholder="类型" clearable style="width: 120px">
        <el-option label="新粉" value="新粉"></el-option>
        <el-option label="重粉" value="重粉"></el-option>
      </el-select>
      <el-button type="primary" @click="search">搜索</el-button>
      <span class="admin-hint">「重粉」= 该客户在别的会话/商户处也出现过（撞单信号）</span>
    </div>
    <el-table :data="rows" v-loading="loading" border stripe>
      <el-table-column prop="username" label="商户" width="120"></el-table-column>
      <el-table-column prop="platform" label="平台" width="130"></el-table-column>
      <el-table-column prop="account" label="客户标识" width="160" show-overflow-tooltip></el-table-column>
      <el-table-column prop="nickName" label="昵称" width="150" show-overflow-tooltip></el-table-column>
      <el-table-column label="类型" width="90">
        <template slot-scope="scope">
          <el-tag :type="scope.row.fanType === '重粉' ? 'warning' : 'success'" size="mini">
            {{ scope.row.fanType }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="seenCount" label="被见到次数" width="110"></el-table-column>
      <el-table-column prop="loginAccount" label="接入账号" width="130" show-overflow-tooltip></el-table-column>
      <el-table-column label="进粉时间" width="170">
        <template slot-scope="scope">
          <span v-if="scope.row.createTime">{{ scope.row.createTime | formatDateTime }}</span>
          <span v-else class="admin-muted">—</span>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination style="margin-top:12px" :current-page="page" :page-size="size" :total="total"
                   layout="total, prev, pager, next" @current-change="onPage"></el-pagination>
  </div>
</template>
<script>
/**
 * 进粉统计。
 *
 * 一行 = 客户端第一次见到某个客户（一条 conversation）。
 *
 * 「新粉 / 重粉」的判定：同一个 customer 被几个会话见过。
 * 重粉**就是撞单信号** —— 同一个客户在别的账号或别的商户那里也出现过。
 * 这正是运营最需要优先看到的那批人，所以直接放在列表里，
 * 而不是藏进详情页等人去翻。
 *
 * 与「在线账号」一样，这里也曾经查旧工单模型的 order_fans 空表并返回 503，
 * 现在改读 conversations + customers。
 */
export default {
  data() {
    return { keyword: '', type: '', loading: false, rows: [], page: 1, size: 10, total: 0 }
  },
  mounted() { this.load() },
  methods: {
    search() { this.page = 1; this.load() },
    load() {
      this.loading = true
      this.getRequest('/admin/fans', {
        page: this.page, rows: this.size, keyword: this.keyword, type: this.type
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
