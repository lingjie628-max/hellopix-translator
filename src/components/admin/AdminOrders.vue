<template>
  <div class="admin-page">
    <div class="admin-bar">
      <el-input v-model="keyword" placeholder="工单号 / 名称 / 商户" style="width: 240px" clearable></el-input>
      <el-button type="primary" @click="load">搜索</el-button>
    </div>
    <el-table :data="rows" v-loading="loading" border stripe>
      <el-table-column prop="serialNumber" label="工单号" width="170"></el-table-column>
      <el-table-column prop="username" label="商户" width="110"></el-table-column>
      <el-table-column prop="title" label="工单名称" min-width="160"></el-table-column>
      <el-table-column prop="type" label="类型" width="110"></el-table-column>
      <el-table-column label="端口" width="100">
        <template slot-scope="scope">{{ scope.row.usePorts }}/{{ scope.row.port }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template slot-scope="scope">
          <el-tag :type="scope.row.status === 1 ? 'success' : (scope.row.status === 2 ? 'warning' : 'danger')" size="mini">
            {{ statusText(scope.row.status) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="expirationTime" label="到期时间" width="170"></el-table-column>
      <el-table-column label="操作" width="160">
        <template slot-scope="scope">
          <el-button type="text" @click="setStatus(scope.row, 1)" :disabled="scope.row.status===1">开启</el-button>
          <el-button type="text" @click="setStatus(scope.row, 2)" :disabled="scope.row.status===2">关闭</el-button>
        </template>
      </el-table-column>
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
    statusText(v) {
      return { 1: '正常', 2: '关闭', 3: '过期', 4: '删除' }[v] || v
    },
    load() {
      this.loading = true
      this.getRequest('/admin/orders', { page: this.page, rows: this.size, keyword: this.keyword }).then(resp => {
        this.loading = false
        if (resp && resp.status == 200) {
          this.rows = resp.data.rows
          this.total = resp.data.total
        }
      }).catch(() => { this.loading = false })
    },
    onPage(page) { this.page = page; this.load() },
    setStatus(row, status) {
      this.postRequest('/admin/orders/status', { id: row.id, status }).then(() => this.load())
    }
  }
}
</script>
<style scoped>
.admin-page { text-align: left; }
.admin-bar { margin-bottom: 12px; }
</style>
