<template>
  <div class="admin-page">
    <el-table :data="rows" border stripe>
      <el-table-column prop="id" label="ID" width="60"></el-table-column>
      <el-table-column prop="title" label="套餐" width="160"></el-table-column>
      <el-table-column prop="price" label="价格(元)" width="90"></el-table-column>
      <el-table-column label="字符" width="100">
        <template slot-scope="scope">{{ (scope.row.chars || 0) / 10000 }} 万</template>
      </el-table-column>
      <el-table-column label="客户端权益" width="180">
        <template slot-scope="scope">
          <el-tag v-if="scope.row.clients && scope.row.clients.standalone" size="mini">独立应用</el-tag>
          <el-tag v-if="scope.row.clients && scope.row.clients.mobile" size="mini" type="success">手机版</el-tag>
          <el-tag v-if="scope.row.clients && scope.row.clients.counter" size="mini" type="warning">计数器</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="翻译通道" min-width="200">
        <template slot-scope="scope">
          <el-tag v-for="id in (scope.row.engines || [])" :key="id" size="mini" style="margin: 0 4px 4px 0">{{ nameOf(id) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="90">
        <template slot-scope="scope">
          <el-button type="text" @click="edit(scope.row)">编辑</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-dialog title="编辑套餐" :visible.sync="visible" width="620px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="名称"><el-input v-model="form.title"></el-input></el-form-item>
        <el-form-item label="说明"><el-input v-model="form.subtitle"></el-input></el-form-item>
        <el-form-item label="价格"><el-input-number v-model="form.price" :min="0"></el-input-number></el-form-item>
        <el-form-item label="字符数"><el-input-number v-model="form.chars" :min="0" :step="150000"></el-input-number></el-form-item>
        <el-form-item label="客户端">
          <el-checkbox :value="!!(form.clients && form.clients.standalone)" @change="val => setClient('standalone', val)">独立应用版</el-checkbox>
          <el-checkbox :value="!!(form.clients && form.clients.mobile)" @change="val => setClient('mobile', val)">手机版</el-checkbox>
          <el-checkbox :value="!!(form.clients && form.clients.counter)" @change="val => setClient('counter', val)">计数器版本</el-checkbox>
        </el-form-item>
        <el-form-item label="翻译通道">
          <el-checkbox-group v-model="form.engines">
            <el-checkbox v-for="item in engineList" :key="item.id" :label="item.id" style="width: 46%; margin: 4px 0">
              {{ item.name }}
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="功能开关">
          <el-checkbox v-for="item in featureList" :key="item.key"
                       :value="!!(form.features && form.features[item.key])"
                       @change="val => setFeat(item.key, val)"
                       style="width: 46%; margin: 4px 0">{{ item.label }}</el-checkbox>
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
const FEATURES = [
  { key: 'autoFill', label: '自动补录' },
  { key: 'export', label: '数据导出' },
  { key: 'moveMaster', label: '主号移出工' },
  { key: 'fanStats', label: '实时统计进粉数' },
  { key: 'autoReply', label: 'WA新对话自动回复' },
  { key: 'assistant', label: '聊天助手' },
  { key: 'repeatFan', label: '工单标记粉丝重粉' },
  { key: 'rotate', label: '主号分配轮切' },
  { key: 'keepChat', label: 'WA封号保留聊天记录' },
  { key: 'counterRepeat', label: '计数器账号标记重粉' },
  { key: 'ssl', label: '数据SSL协议加密传输' },
  { key: 'aws', label: 'AWS云安全加密' },
  { key: 'support', label: '客服一对一辅导' },
  { key: 'feedback', label: '问题反馈' }
]

export default {
  data() {
    return {
      rows: [],
      visible: false,
      form: { features: {}, engines: [], clients: {} },
      featureList: FEATURES,
      engineList: []
    }
  },
  mounted() {
    this.getRequest('/admin/engines').then(resp => {
      if (resp) this.engineList = resp.data.rows || []
    })
    this.load()
  },
  methods: {
    nameOf(id) {
      const item = this.engineList.find(e => e.id === id)
      return item ? item.name : id
    },
    setFeat(key, val) {
      if (!this.form.features) this.$set(this.form, 'features', {})
      this.$set(this.form.features, key, val ? 1 : 0)
    },
    setClient(key, val) {
      if (!this.form.clients) this.$set(this.form, 'clients', {})
      this.$set(this.form.clients, key, val ? 1 : 0)
    },
    load() {
      this.getRequest('/admin/packages').then(resp => { if (resp) this.rows = resp.data })
    },
    edit(row) {
      this.form = Object.assign({}, row, {
        features: Object.assign({}, row.features || {}),
        engines: (row.engines || []).slice(),
        clients: Object.assign({ standalone: 0, mobile: 0, counter: 0 }, row.clients || {})
      })
      this.visible = true
    },
    save() {
      this.postRequest('/admin/packages/save', Object.assign({}, this.form, {
        features: JSON.stringify(this.form.features || {}),
        engines: JSON.stringify(this.form.engines || []),
        clients: JSON.stringify(this.form.clients || {})
      })).then(resp => {
        this.$message.success(resp.data.msg)
        this.visible = false
        this.load()
      })
    }
  }
}
</script>
<style scoped>
.admin-page { text-align: left; }
</style>
