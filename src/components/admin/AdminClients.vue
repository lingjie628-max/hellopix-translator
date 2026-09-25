<template>
  <div class="admin-page">
    <el-alert title="独立应用是 Hello Pix 单应用翻译客户端，对应 App 必须选平台 ID（如 signal、telegram-z）。空地址只能保存为下架草稿，上架后才会出现在官网和客户端页脚。" type="info" show-icon :closable="false" style="margin-bottom:12px"></el-alert>
    <div class="admin-bar">
      <el-select v-model="group" clearable placeholder="分组" style="width: 140px" @change="load">
        <el-option v-for="g in groups" :key="groupKey(g)" :label="groupLabel(g)" :value="groupLabel(g)"></el-option>
      </el-select>
      <el-input v-model="keyword" placeholder="名称 / 系统 / App" style="width: 200px" clearable></el-input>
      <el-button type="primary" @click="load">搜索</el-button>
      <el-button type="success" @click="open()">新增版本</el-button>
    </div>
    <el-table :data="rows" v-loading="loading" border stripe>
      <el-table-column prop="group" label="分组" width="100"></el-table-column>
      <el-table-column prop="title" label="名称" width="160"></el-table-column>
      <el-table-column prop="os" label="系统" width="130"></el-table-column>
      <el-table-column label="架构" width="150">
        <template slot-scope="scope">{{ archLabel(scope.row.arch) }}</template>
      </el-table-column>
      <el-table-column label="对应 App" width="160">
        <template slot-scope="scope">{{ appLabel(scope.row.app) }}</template>
      </el-table-column>
      <el-table-column prop="version" label="版本号" width="90"></el-table-column>
      <el-table-column prop="url" label="下载地址" min-width="180" show-overflow-tooltip></el-table-column>
      <el-table-column label="上架" width="80">
        <template slot-scope="scope">
          <el-tag :type="scope.row.enabled ? 'success' : 'info'" size="mini">{{ scope.row.enabled ? '上架' : '下架' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="90">
        <template slot-scope="scope">
          <el-button type="text" @click="open(scope.row)">编辑</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog :title="form.id ? '编辑客户端' : '新增客户端'" :visible.sync="visible" width="520px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="分组">
          <el-select v-model="form.group" style="width:100%" @change="onGroupChange">
            <el-option v-for="g in groups" :key="groupKey(g)" :label="groupLabel(g)" :value="groupLabel(g)"></el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="名称"><el-input v-model="form.title"></el-input></el-form-item>
        <el-form-item label="系统"><el-input v-model="form.os"></el-input></el-form-item>
        <el-form-item label="架构">
          <el-select v-model="form.arch" style="width:100%" clearable placeholder="不限架构（任意系统都能用）">
            <el-option label="x64（Intel/AMD 64 位）" value="x64"></el-option>
            <el-option label="arm64（Apple 芯片 / ARM 64 位）" value="arm64"></el-option>
            <el-option label="不限架构" value=""></el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="对应 App">
          <el-select v-if="isStandalone" v-model="form.app" style="width:100%" placeholder="选择平台应用 ID">
            <el-option v-for="item in standaloneApps" :key="item.id" :label="item.name + '（' + item.id + '）'" :value="item.id"></el-option>
          </el-select>
          <el-input v-else v-model="form.app" placeholder="可选，非独立应用分组"></el-input>
        </el-form-item>
        <el-form-item label="版本号"><el-input v-model="form.version"></el-input></el-form-item>
        <el-form-item label="下载地址"><el-input v-model="form.url" placeholder="上架必须是 HTTPS 地址"></el-input></el-form-item>
        <el-form-item label="上架">
          <el-switch v-model="form.enabled" :active-value="1" :inactive-value="0"></el-switch>
        </el-form-item>
        <el-form-item label="备注"><el-input type="textarea" v-model="form.note"></el-input></el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="visible=false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </span>
    </el-dialog>
  </div>
</template>
<script>
const DEFAULT_GROUPS = [
  { id: 'windows', label: 'Windows' },
  { id: 'macos', label: 'macOS' },
  { id: 'android', label: 'Android' },
  { id: 'ios', label: 'iOS' },
  { id: 'standalone', label: '独立应用' },
  { id: 'counter', label: '计数器' }
]

export default {
  data() {
    return {
      groups: DEFAULT_GROUPS.slice(),
      standaloneApps: [],
      group: '',
      keyword: '',
      loading: false,
      rows: [],
      visible: false,
      form: {}
    }
  },
  computed: {
    isStandalone() {
      return this.form.group === '独立应用' || this.form.group === 'standalone'
    }
  },
  mounted() { this.load() },
  methods: {
    groupKey(item) {
      return item && item.id ? item.id : item
    },
    groupLabel(item) {
      return item && item.label ? item.label : item
    },
    appLabel(appId) {
      const found = this.standaloneApps.find(item => item.id === appId)
      return found ? found.name + '（' + found.id + '）' : appId
    },
    onGroupChange() {
      if (this.isStandalone && !this.standaloneApps.some(item => item.id === this.form.app)) {
        this.form.app = this.standaloneApps[0] ? this.standaloneApps[0].id : ''
      }
    },
    load() {
      this.loading = true
      this.getRequest('/admin/clients', { page: 1, rows: 50, group: this.group, keyword: this.keyword }).then(resp => {
        this.loading = false
        if (resp && resp.status == 200) {
          this.rows = resp.data.rows || []
          if (resp.data.groups && resp.data.groups.length) this.groups = resp.data.groups
          if (resp.data.standaloneApps) this.standaloneApps = resp.data.standaloneApps
        }
      }).catch(() => { this.loading = false })
    },
    /**
     * 架构展示。
     *
     * 这一列历史上是自由文本，库里可能同时躺着 `x64`、`64位`、`Apple 芯片`
     * 等写法。这里统一归一后再显示，让人一眼看出**这条记录会被哪些客户端选中** ——
     * 而不是把原始字符串原样端出来，让运营自己去猜它匹配谁。
     *
     * 判断顺序与服务端 release-arch.js 一致：ARM 必须先判，
     * 否则 `arm64` 会被里面的 "64" 抢成 x64。
     */
    archLabel(raw) {
      const t = String(raw || '').trim().toLowerCase()
      if (!t) return '不限架构'
      if (/arm|apple|aarch/.test(t) || /^m[1-9]$/.test(t)) return 'arm64（Apple 芯片）'
      if (/x64|x86[_-]?64|amd64|intel/.test(t)) return 'x64（Intel/AMD）'
      if (/ia32|x86|win32|32/.test(t)) return 'ia32（32 位）'
      if (/64/.test(t)) return 'x64（Intel/AMD）'
      return '无法识别（不会被选中）'
    },
    open(row) {
      this.form = row ? Object.assign({}, row) : { group: 'Windows', title: '', os: '', arch: '', app: '', version: '1.0.0', url: '', enabled: 0, note: '' }
      if (this.isStandalone && !this.standaloneApps.some(item => item.id === this.form.app)) {
        this.form.app = this.standaloneApps[0] ? this.standaloneApps[0].id : this.form.app
      }
      this.visible = true
    },
    save() {
      this.postRequest('/admin/clients/save', this.form).then(resp => {
        this.$message({ type: resp.data.success === 'error' || resp.data.success === false ? 'error' : 'success', message: resp.data.msg })
        if (resp.data.success !== 'error' && resp.data.success !== false) {
          this.visible = false
          this.load()
        }
      })
    }
  }
}
</script>
<style scoped>
.admin-page { text-align: left; }
.admin-bar { margin-bottom: 12px; }
</style>
