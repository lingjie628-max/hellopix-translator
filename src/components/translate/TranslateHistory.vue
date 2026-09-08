<template>
  <div class="pix-history">
    <el-header style="text-align: left; height: auto; padding: 0;">
      <el-button type="danger" plain icon="el-icon-delete" :disabled="!ids" @click="removeSelected">删除所选</el-button>
    </el-header>
    <el-main style="padding-left: 0; padding-top: 12px;">
      <el-table :data="rows" v-loading="tableLoading" border stripe @selection-change="onSelect">
        <el-table-column type="selection" width="42" align="center"></el-table-column>
        <el-table-column prop="sourceLang" label="原文语种" width="100" align="center"></el-table-column>
        <el-table-column prop="targetLang" label="译文语种" width="100" align="center"></el-table-column>
        <el-table-column prop="source" label="原文" min-width="220" show-overflow-tooltip></el-table-column>
        <el-table-column prop="target" label="译文" min-width="220" show-overflow-tooltip></el-table-column>
        <el-table-column prop="chars" label="字符" width="80" align="center"></el-table-column>
        <el-table-column prop="createTime" label="时间" width="180" align="center">
          <template slot-scope="scope">{{ scope.row.createTime | formatDateTime }}</template>
        </el-table-column>
      </el-table>
      <el-pagination
        style="margin-top: 12px;"
        @current-change="onPage"
        @size-change="onSize"
        :current-page="page"
        :page-sizes="[10, 20, 50]"
        :page-size="size"
        layout="total, sizes, prev, pager, next"
        :total="total">
      </el-pagination>
    </el-main>
  </div>
</template>

<script>
export default {
  name: 'HelloPixHistory',
  data() {
    return {
      rows: [],
      tableLoading: false,
      page: 1,
      size: 10,
      total: 0,
      ids: ''
    }
  },
  mounted() {
    this.load()
  },
  methods: {
    load() {
      this.tableLoading = true
      this.getRequest('/translate/history', { page: this.page, rows: this.size }).then(resp => {
        this.tableLoading = false
        if (resp && resp.status == 200) {
          this.rows = resp.data.rows || []
          this.total = resp.data.total || 0
        }
      }).catch(() => { this.tableLoading = false })
    },
    onPage(page) {
      this.page = page
      this.load()
    },
    onSize(size) {
      this.size = size
      this.load()
    },
    onSelect(selection) {
      this.ids = selection.map(item => item.id).join(',')
    },
    removeSelected() {
      this.$confirm('删除所选翻译记录？', '提示', { type: 'warning' }).then(() => {
        this.postRequest('/translate/deleteHistory', { ids: this.ids }).then(() => {
          this.$message.success('已删除')
          this.load()
        })
      }).catch(() => {})
    }
  }
}
</script>

<style scoped>
.pix-history {
  text-align: left;
}
</style>
