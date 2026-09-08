<template>
  <div class="admin-page">
    <div class="admin-bar">
      <el-input v-model="keyword" placeholder="链接 / 工单 / 商户" style="width: 240px" clearable></el-input>
      <el-button type="primary" @click="load">搜索</el-button>
    </div>
    <el-table :data="rows" v-loading="loading" border stripe>
      <el-table-column prop="username" label="商户" width="100"></el-table-column>
      <el-table-column prop="orderNum" label="工单号" width="160"></el-table-column>
      <el-table-column prop="shareLink" label="分流链接" min-width="220" show-overflow-tooltip></el-table-column>
      <el-table-column prop="hits" label="点击" width="80"></el-table-column>
      <el-table-column prop="accounts" label="分配主号" min-width="180" show-overflow-tooltip></el-table-column>
      <el-table-column prop="message" label="文案" min-width="160" show-overflow-tooltip></el-table-column>
    </el-table>
    <el-pagination style="margin-top:12px" :current-page="page" :page-size="size" :total="total"
                   layout="total, prev, pager, next" @current-change="onPage"></el-pagination>
  </div>
</template>
<script>
export default {
  data() {
    return { keyword: '', loading: false, rows: [], page: 1, size: 10, total: 0 }
  },
  mounted() { this.load() },
  methods: {
    load() {
      this.loading = true
      this.getRequest('/admin/links', { page: this.page, rows: this.size, keyword: this.keyword }).then(resp => {
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
