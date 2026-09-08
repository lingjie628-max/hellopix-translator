<template>
  <div class="admin-page">
    <el-table :data="rows" v-loading="loading" border stripe>
      <el-table-column prop="orderNum" label="订单号" width="160"></el-table-column>
      <el-table-column prop="username" label="商户" width="110"></el-table-column>
      <el-table-column prop="kind" label="类型" width="80">
        <template slot-scope="scope">{{ scope.row.kind || '套餐' }}</template>
      </el-table-column>
      <el-table-column prop="basename" label="套餐/字符包" width="160"></el-table-column>
      <el-table-column prop="price" label="金额" width="90"></el-table-column>
      <el-table-column prop="month" label="月数" width="80"></el-table-column>
      <el-table-column prop="type" label="方式" width="90"></el-table-column>
      <el-table-column label="状态" width="110">
        <template slot-scope="scope">
          <el-tag :type="scope.row.status === 1 ? 'success' : 'danger'" size="mini">
            {{ scope.row.status === 1 ? '已支付' : '未支付' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="createTime" label="时间" width="170"></el-table-column>
      <el-table-column label="操作" width="120">
        <template slot-scope="scope">
          <el-button type="text" v-if="scope.row.status !== 1" @click="markPaid(scope.row)">标记已付</el-button>
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
    return { loading: false, rows: [], page: 1, size: 10, total: 0 }
  },
  mounted() { this.load() },
  methods: {
    load() {
      this.loading = true
      this.getRequest('/admin/recharges', { page: this.page, rows: this.size }).then(resp => {
        this.loading = false
        if (resp && resp.status == 200) {
          this.rows = resp.data.rows
          this.total = resp.data.total
        }
      }).catch(() => { this.loading = false })
    },
    onPage(page) { this.page = page; this.load() },
    markPaid(row) {
      this.postRequest('/admin/recharges/status', { id: row.id, status: 1 }).then(() => this.load())
    }
  }
}
</script>
<style scoped>
.admin-page { text-align: left; }
</style>
