<template>
  <div class="admin-page">
    <el-tabs v-model="kind" @tab-click="load">
      <el-tab-pane label="登录日志" name="login"></el-tab-pane>
      <el-tab-pane label="超管审计" name="audit"></el-tab-pane>
    </el-tabs>
    <div class="admin-bar">
      <el-input v-model="keyword" placeholder="搜索" style="width: 220px" clearable></el-input>
      <el-button type="primary" @click="load">搜索</el-button>
    </div>
    <el-table v-if="kind==='login'" :data="rows" v-loading="loading" border stripe>
      <el-table-column prop="loginTime" label="时间" width="170"></el-table-column>
      <el-table-column prop="username" label="商户" width="110"></el-table-column>
      <el-table-column prop="account" label="账号" width="150"></el-table-column>
      <el-table-column prop="nickname" label="名称" width="140"></el-table-column>
      <el-table-column prop="loginType" label="类型" width="110"></el-table-column>
      <el-table-column prop="loginIp" label="IP" width="140"></el-table-column>
    </el-table>
    <el-table v-else :data="rows" v-loading="loading" border stripe>
      <el-table-column prop="createTime" label="时间" width="170"></el-table-column>
      <el-table-column prop="admin" label="超管" width="110"></el-table-column>
      <el-table-column prop="action" label="动作" width="140"></el-table-column>
      <el-table-column prop="detail" label="对象" min-width="160"></el-table-column>
      <el-table-column prop="ip" label="IP" width="160"></el-table-column>
    </el-table>
    <el-pagination style="margin-top:12px" :current-page="page" :page-size="size" :total="total"
                   layout="total, prev, pager, next" @current-change="onPage"></el-pagination>
  </div>
</template>
<script>
export default {
  data() {
    return { kind: 'login', keyword: '', loading: false, rows: [], page: 1, size: 10, total: 0 }
  },
  mounted() { this.load() },
  methods: {
    load() {
      this.loading = true
      this.getRequest('/admin/logs', { page: this.page, rows: this.size, keyword: this.keyword, kind: this.kind }).then(resp => {
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
</style>
