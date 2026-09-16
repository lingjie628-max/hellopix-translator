<template>
  <div class="admin-page">
    <el-card>
      <div slot="header">商户首页正在展示</div>
      <div class="current">{{ current || '暂无公告' }}</div>
    </el-card>

    <el-card style="margin-top:16px">
      <div slot="header">
        公告管理
        <el-button type="success" size="mini" style="float:right" @click="open()">发布公告</el-button>
      </div>
      <el-table :data="rows" border stripe>
        <el-table-column prop="title" label="标题" width="180"></el-table-column>
        <el-table-column prop="content" label="内容" min-width="280" show-overflow-tooltip></el-table-column>
        <el-table-column prop="createTime" label="时间" width="170"></el-table-column>
        <el-table-column label="商户可见" width="100">
          <template slot-scope="scope">
            <el-tag :type="scope.row.enabled ? 'success' : 'info'" size="mini">{{ scope.row.enabled ? '展示中' : '已隐藏' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="220">
          <template slot-scope="scope">
            <el-button type="text" @click="open(scope.row)">编辑</el-button>
            <el-button type="text" @click="setShow(scope.row, scope.row.enabled ? 0 : 1)">{{ scope.row.enabled ? '隐藏' : '展示到首页' }}</el-button>
            <el-button type="text" @click="remove(scope.row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog :title="form.id ? '编辑公告' : '发布公告'" :visible.sync="visible" width="520px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="标题"><el-input v-model="form.title"></el-input></el-form-item>
        <el-form-item label="内容"><el-input type="textarea" :rows="5" v-model="form.content"></el-input></el-form-item>
        <el-form-item label="展示到首页">
          <el-switch v-model="form.enabled" :active-value="1" :inactive-value="0"></el-switch>
        </el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="visible=false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </span>
    </el-dialog>
  </div>
</template>
<script>
const GONE_KEY = 'pix_deleted_notices'

function nowText() {
  const d = new Date()
  const p = n => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

function goneIds() {
  try {
    return JSON.parse(window.localStorage.getItem(GONE_KEY) || '[]')
  } catch (e) {
    return []
  }
}

function markGone(id) {
  const ids = goneIds()
  const key = String(id)
  if (ids.indexOf(key) === -1) ids.push(key)
  window.localStorage.setItem(GONE_KEY, JSON.stringify(ids))
}

export default {
  data() {
    return {
      current: '',
      rows: [],
      visible: false,
      form: {}
    }
  },
  mounted() { this.load() },
  methods: {
    refreshCurrent() {
      const shown = this.rows.find(r => Number(r.enabled) === 1)
      this.current = shown ? (shown.content || '') : ''
    },
    persist() {
      this.refreshCurrent()
      return this.postRequest('/admin/settings/save', {
        announcement: this.current,
        notices: JSON.stringify(this.rows)
      })
    },
    load() {
      this.getRequest('/admin/settings').then(resp => {
        if (!resp || !resp.data || typeof resp.data !== 'object') return
        const gone = goneIds()
        if (Array.isArray(resp.data.notices)) {
          this.rows = resp.data.notices.filter(r => gone.indexOf(String(r.id)) === -1)
        }
        this.refreshCurrent()
        if (!this.current && resp.data.announcement && !this.rows.length) {
          this.current = resp.data.announcement
        }
      })
    },
    open(row) {
      this.form = row ? Object.assign({}, row) : { title: '', content: '', enabled: 1 }
      this.visible = true
    },
    save() {
      if (!this.form.title && !this.form.content) {
        this.$message.error('请填写公告内容')
        return
      }
      const payload = Object.assign({}, this.form)
      if (payload.id) {
        this.rows = this.rows.map(r => String(r.id) === String(payload.id) ? Object.assign({}, r, payload) : r)
      } else {
        payload.id = Date.now()
        payload.createTime = nowText()
        this.rows = [payload].concat(this.rows)
      }
      if (Number(payload.enabled) === 1) {
        this.rows = this.rows.map(r => Object.assign({}, r, { enabled: String(r.id) === String(payload.id) ? 1 : 0 }))
      }
      this.persist().then(() => {
        this.visible = false
        this.$message.success('公告已保存，商户首页已更新')
      })
    },
    setShow(row, enabled) {
      this.rows = this.rows.map(r => {
        if (String(r.id) === String(row.id)) return Object.assign({}, r, { enabled: enabled })
        if (enabled) return Object.assign({}, r, { enabled: 0 })
        return r
      })
      this.persist().then(() => {
        this.$message.success(enabled ? '已展示到商户首页' : '已从商户首页隐藏')
      })
    },
    remove(row) {
      this.$confirm('删除后商户首页不再展示这条公告。', '提示', { type: 'warning' }).then(() => {
        markGone(row.id)
        this.rows = this.rows.filter(r => String(r.id) !== String(row.id))
        this.persist().then(() => {
          this.$message.success('公告已删除')
        })
      }).catch(() => {})
    }
  }
}
</script>
<style scoped>
.admin-page { text-align: left; }
.current { color: var(--w-warning); line-height: 1.7; min-height: 24px; white-space: pre-wrap; }
</style>
