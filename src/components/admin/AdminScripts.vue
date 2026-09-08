<template>
  <div class="admin-page">
    <div class="admin-bar">
      <el-input v-model="keyword" placeholder="关键词 / 原文 / 译文" style="width: 240px" clearable></el-input>
      <el-button type="primary" @click="load">搜索</el-button>
    </div>
    <el-table :data="rows" v-loading="loading" border stripe>
      <el-table-column prop="username" label="商户" width="100"></el-table-column>
      <el-table-column prop="groupTitle" label="分组" width="120"></el-table-column>
      <el-table-column prop="keyword" label="关键词" width="120"></el-table-column>
      <el-table-column prop="source" label="原文" min-width="160" show-overflow-tooltip></el-table-column>
      <el-table-column prop="target" label="发送译文" min-width="180" show-overflow-tooltip></el-table-column>
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
      this.getRequest('/admin/scripts', { page: this.page, rows: this.size, keyword: this.keyword }).then(resp => {
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
