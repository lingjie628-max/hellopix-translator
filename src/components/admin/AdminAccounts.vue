<template>
  <div class="admin-page">
    <div class="admin-bar">
      <el-input v-model="keyword" placeholder="账号 / 昵称 / 商户 / 工单号" style="width: 260px" clearable></el-input>
      <el-select v-model="online" placeholder="在线状态" clearable style="width: 120px">
        <el-option label="在线" value="1"></el-option>
        <el-option label="离线" value="0"></el-option>
      </el-select>
      <el-button type="primary" @click="load">搜索</el-button>
    </div>
    <el-table :data="rows" v-loading="loading" border stripe>
      <el-table-column prop="username" label="商户" width="100"></el-table-column>
      <el-table-column prop="orderNum" label="工单号" width="160"></el-table-column>
      <el-table-column prop="account" label="主号" width="150"></el-table-column>
      <el-table-column prop="nickName" label="昵称" width="120"></el-table-column>
      <el-table-column label="在线" width="80">
        <template slot-scope="scope">
          <el-tag :type="scope.row.onlineStatus === 1 ? 'success' : 'info'" size="mini">{{ scope.row.onlineStatus === 1 ? '在线' : '离线' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="占用端口" width="90">
        <template slot-scope="scope">{{ scope.row.occupied === 1 ? '是' : '否' }}</template>
      </el-table-column>
      <el-table-column prop="completedDayTarget" label="当日进粉" width="90"></el-table-column>
      <el-table-column prop="lastLogintime" label="最后登录" width="170"></el-table-column>
    </el-table>
    <el-pagination style="margin-top:12px" :current-page="page" :page-size="size" :total="total"
                   layout="total, prev, pager, next" @current-change="onPage"></el-pagination>
  </div>
</template>
<script>
export default {
  data() {
    return { keyword: '', online: '', loading: false, rows: [], page: 1, size: 10, total: 0 }
  },
  mounted() { this.load() },
  methods: {
    load() {
      this.loading = true
      this.getRequest('/admin/accounts', { page: this.page, rows: this.size, keyword: this.keyword, online: this.online }).then(resp => {
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
