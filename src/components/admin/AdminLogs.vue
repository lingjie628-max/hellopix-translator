<template>
  <div class="admin-page">
    <el-tabs v-model="kind" @tab-click="reload">
      <el-tab-pane label="登录日志" name="login"></el-tab-pane>
      <el-tab-pane label="超管审计" name="audit"></el-tab-pane>
    </el-tabs>
    <div class="admin-bar">
      <el-input v-model="keyword" placeholder="搜索" style="width: 220px" clearable @keyup.enter.native="reload"></el-input>
      <el-button type="primary" @click="reload">搜索</el-button>
    </div>

    <el-table v-if="kind==='login'" :data="rows" v-loading="loading" border stripe>
      <el-table-column label="时间" width="170">
        <template slot-scope="scope">
          <span class="mono">{{ timeOf(scope.row.loginTime || scope.row.createTime) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="商户" width="120">
        <template slot-scope="scope">
          {{ scope.row.username || scope.row.parentUsername || '—' }}
        </template>
      </el-table-column>
      <el-table-column prop="account" label="账号" width="150"></el-table-column>
      <el-table-column prop="nickname" label="名称" width="130">
        <template slot-scope="scope">{{ scope.row.nickname || '—' }}</template>
      </el-table-column>
      <el-table-column prop="loginType" label="类型" width="110"></el-table-column>
      <el-table-column label="结果" width="80">
        <template slot-scope="scope">
          <el-tag v-if="scope.row.result" :type="scope.row.result === '成功' ? 'success' : 'danger'" size="mini">
            {{ scope.row.result }}
          </el-tag>
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column prop="loginIp" label="IP" width="150"></el-table-column>
      <el-table-column prop="failureReason" label="失败原因" min-width="140">
        <template slot-scope="scope">{{ scope.row.failureReason || '' }}</template>
      </el-table-column>
    </el-table>

    <el-table v-else :data="rows" v-loading="loading" border stripe>
      <el-table-column label="时间" width="170">
        <template slot-scope="scope">
          <span class="mono">{{ timeOf(scope.row.createTime) }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="admin" label="超管" width="110"></el-table-column>
      <el-table-column prop="action" label="动作" width="180"></el-table-column>
      <el-table-column prop="detail" label="对象" min-width="200" show-overflow-tooltip></el-table-column>
      <el-table-column prop="ip" label="IP" width="150"></el-table-column>
    </el-table>

    <el-pagination style="margin-top:12px" :current-page="page" :page-size="size" :total="total"
                   layout="total, prev, pager, next" @current-change="onPage"></el-pagination>
  </div>
</template>
<script>
import { formatDateTime } from '../../utils/filters'

export default {
  data() {
    return { kind: 'login', keyword: '', loading: false, rows: [], page: 1, size: 20, total: 0 }
  },
  mounted() { this.load() },
  methods: {
    /**
     * 时间显示。
     *
     * 后端返回的是 ISO 串（`2026-11-01T16:12:11.877Z`），直接塞进表格会是
     * 一长串没人想读的东西。`formatDateTime` 按浏览器本地时区渲染成
     * `2026-11-02 00:12:11` —— 运维看日志就是想知道"北京时间几点"。
     *
     * 字段名兼容两种：真库给 `createTime`，旧 mock 给 `loginTime`。
     * 真库和 mock 会慢慢趋于一致，但历史数据已经这样了，先都认。
     */
    timeOf(value) {
      return value ? formatDateTime(value) : '—'
    },
    reload() {
      this.page = 1
      this.load()
    },
    load() {
      this.loading = true
      this.getRequest('/admin/logs', { page: this.page, rows: this.size, keyword: this.keyword, kind: this.kind }).then(resp => {
        this.loading = false
        if (resp && resp.status == 200) {
          this.rows = resp.data.rows || []
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
/* 时间是等宽数字才好对齐扫读 —— 一列时间错位看着很难受 */
.mono { font-variant-numeric: tabular-nums; }
</style>
