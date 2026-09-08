<template>
  <div class="admin-page">
    <el-alert
      :title="'全站通道 ' + rows.length + ' 个。成本由超管填写，不调取厂商计费。商户按套餐整包买：' + (meta.packageBill || '基础 ¥200/150万 · 高级 ¥350/150万 · 专业 ¥850/150万') + '。接口板块已就位。当前默认：' + activeName"
      type="info" show-icon :closable="false" style="margin-bottom:12px">
    </el-alert>
    <el-table :data="rows" border stripe>
      <el-table-column prop="name" label="通道" width="150"></el-table-column>
      <el-table-column prop="provider" label="厂商" width="100"></el-table-column>
      <el-table-column label="档位" width="90">
        <template slot-scope="scope">{{ tierText(scope.row.tier) }}</template>
      </el-table-column>
      <el-table-column prop="costPerMillion" label="成本元/百万字" width="130"></el-table-column>
      <el-table-column label="接口" width="90">
        <template slot-scope="scope">
          <el-tag :type="scope.row.wired ? 'success' : 'info'" size="mini">{{ scope.row.wiredText }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="密钥" width="80">
        <template slot-scope="scope">{{ scope.row.hasKey ? '已填' : '空' }}</template>
      </el-table-column>
      <el-table-column label="启用" width="70">
        <template slot-scope="scope">
          <el-tag :type="scope.row.enabled ? 'success' : 'info'" size="mini">{{ scope.row.enabled ? '开' : '关' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="默认" width="80">
        <template slot-scope="scope">
          <el-tag v-if="scope.row.active" type="danger" size="mini">使用中</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="note" label="说明" min-width="180" show-overflow-tooltip></el-table-column>
      <el-table-column label="操作" width="160">
        <template slot-scope="scope">
          <el-button type="text" @click="edit(scope.row)">配置</el-button>
          <el-button type="text" @click="activate(scope.row)" :disabled="scope.row.active">设为默认</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog title="配置翻译通道" :visible.sync="visible" width="520px">
      <el-form :model="form" label-width="110px">
        <el-form-item label="通道">{{ form.name }}（{{ form.provider }}）</el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="form.enabled" :active-value="1" :inactive-value="0"></el-switch>
        </el-form-item>
        <el-form-item label="成本元/百万">
          <el-input-number v-model="form.costPerMillion" :min="0" :precision="2"></el-input-number>
        </el-form-item>
        <el-form-item label="模型">
          <el-input v-model="form.model" placeholder="GPT / Grok 填写，其它可空"></el-input>
        </el-form-item>
        <el-form-item label="接口地址">
          <el-input v-model="form.endpoint" placeholder="以后接服务时再填"></el-input>
        </el-form-item>
        <el-form-item label="API Key">
          <el-input v-model="form.apiKey" placeholder="不填则保持原值" show-password></el-input>
        </el-form-item>
        <el-form-item label="Secret">
          <el-input v-model="form.secret" placeholder="百度 / 腾讯 / AWS 等需要" show-password></el-input>
        </el-form-item>
        <el-form-item label="备注">
          <el-input type="textarea" v-model="form.note"></el-input>
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
export default {
  data() {
    return { rows: [], meta: {}, visible: false, form: {} }
  },
  computed: {
    activeName() {
      const row = this.rows.find(r => r.active)
      return row ? row.name : '-'
    }
  },
  mounted() { this.load() },
  methods: {
    tierText(tier) {
      return { basic: '基础', advanced: '高级', pro: '专业' }[tier] || tier
    },
    load() {
      this.getRequest('/admin/engines').then(resp => {
        if (!resp) return
        this.rows = resp.data.rows
        this.meta = resp.data
      })
    },
    edit(row) {
      this.form = Object.assign({}, row, { apiKey: '', secret: '' })
      this.visible = true
    },
    save() {
      this.postRequest('/admin/engines/save', this.form).then(resp => {
        this.$message.success(resp.data.msg)
        this.visible = false
        this.load()
      })
    },
    activate(row) {
      this.postRequest('/admin/engines/active', { id: row.id }).then(resp => {
        this.$message.success(resp.data.msg)
        this.load()
      })
    }
  }
}
</script>
<style scoped>
.admin-page { text-align: left; }
</style>
