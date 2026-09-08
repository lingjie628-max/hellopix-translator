<template>
  <div class="admin-page">
    <div class="admin-bar">
      <el-input v-model="keyword" placeholder="粉丝账号 / 昵称 / 商户 / 工单" style="width: 260px" clearable></el-input>
      <el-select v-model="type" placeholder="类型" clearable style="width: 120px">
        <el-option label="新粉" value="新粉"></el-option>
        <el-option label="重粉" value="重粉"></el-option>
      </el-select>
      <el-button type="primary" @click="load">搜索</el-button>
    </div>
    <el-table :data="rows" v-loading="loading" border stripe>
      <el-table-column prop="username" label="商户" width="100"></el-table-column>
      <el-table-column prop="orderNum" label="工单号" width="160"></el-table-column>
      <el-table-column prop="account" label="粉丝账号" width="150"></el-table-column>
      <el-table-column prop="nickName" label="昵称" width="120"></el-table-column>
      <el-table-column prop="type" label="类型" width="80"></el-table-column>
      <el-table-column prop="loginAccount" label="接入主号" width="150"></el-table-column>
      <el-table-column prop="createTime" label="进粉时间" width="170"></el-table-column>
    </el-table>
    <el-pagination style="margin-top:12px" :current-page="page" :page-size="size" :total="total"
                   layout="total, prev, pager, next" @current-change="onPage"></el-pagination>
  </div>
</template>
<script>
export default {
  data() {
    return { keyword: '', type: '', loading: false, rows: [], page: 1, size: 10, total: 0 }
  },
  mounted() { this.load() },
  methods: {
    load() {
      this.loading = true
      this.getRequest('/admin/fans', { page: this.page, rows: this.size, keyword: this.keyword, type: this.type }).then(resp => {
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
