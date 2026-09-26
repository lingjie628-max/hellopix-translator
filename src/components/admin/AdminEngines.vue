<template>
  <div class="admin-page">
    <el-alert
      :title="'全站通道 ' + rows.length + ' 个。成本由超管填写，不调取厂商计费。商户按套餐整包买：' + (meta.packageBill || '套餐价格见「套餐管理」页') + '。当前默认：' + activeName"
      type="info" show-icon :closable="false" style="margin-bottom:12px">
    </el-alert>
    <el-table :data="rows" border stripe>
      <el-table-column prop="name" label="通道" width="140"></el-table-column>
      <el-table-column prop="provider" label="厂商" width="120"></el-table-column>
      <el-table-column label="档位" width="80">
        <template slot-scope="scope">{{ tierText(scope.row.tier) }}</template>
      </el-table-column>
      <el-table-column prop="costPerMillion" label="成本元/百万字" width="120"></el-table-column>
      <!--
        「真实模型」必须在列表里可见：这是"前台展示的模型与真实调用保持一致"
        这条要求的后台一侧。改模型是影响成本的敏感操作，如果不显示，
        改了没人发现，成本报告与线上行为就会静默对不上。
      -->
      <el-table-column label="真实模型" width="180">
        <template slot-scope="scope">
          <span :class="{ 'model-missing': !scope.row.model }">{{ scope.row.model || '未配置' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="接口" width="90">
        <template slot-scope="scope">
          <el-tag :type="scope.row.wired ? 'success' : 'info'" size="mini">{{ scope.row.wiredText }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template slot-scope="scope">
          <el-tag v-if="scope.row.retired" type="info" size="mini">已下架</el-tag>
          <el-tag v-else :type="scope.row.enabled ? 'success' : 'warning'" size="mini">{{ scope.row.enabled ? '启用' : '停用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="密钥" width="70">
        <template slot-scope="scope">{{ scope.row.hasKey ? '已填' : '空' }}</template>
      </el-table-column>
      <el-table-column label="默认" width="80">
        <template slot-scope="scope">
          <el-tag v-if="scope.row.active" type="danger" size="mini">使用中</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="note" label="说明" min-width="180" show-overflow-tooltip></el-table-column>
      <el-table-column label="操作" width="170">
        <template slot-scope="scope">
          <el-button type="text" @click="edit(scope.row)">配置</el-button>
          <el-button type="text" :disabled="scope.row.active || scope.row.retired" @click="activate(scope.row)">设为默认</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog title="配置翻译通道" :visible.sync="visible" width="600px">
      <el-form :model="form" label-width="120px">
        <el-form-item label="通道">{{ form.name }}（{{ form.provider }}）</el-form-item>
        <el-form-item label="下架">
          <!--
            下架是**软删除**：只打 retired_at 并停用，不删行。
            translate_logs.engine_id 与已售权益记录都还指向它 ——
            删了就再也证明不了"当初卖给客户的是哪几个通道"。
          -->
          <el-switch v-model="form.retired" :active-value="1" :inactive-value="0"></el-switch>
          <span class="hint">下架后商户侧不可见、不可选；历史日志与已售权益保留</span>
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="form.enabled" :active-value="1" :inactive-value="0" :disabled="!!form.retired"></el-switch>
        </el-form-item>
        <el-form-item label="成本元/百万字">
          <el-input-number v-model="form.costPerMillion" :min="0" :precision="2"></el-input-number>
          <span class="hint">粗估口径，权威成本见 translation_usage</span>
        </el-form-item>
        <el-form-item label="真实模型 ID">
          <el-input v-model="form.model" placeholder="例如 gpt-4o-mini / claude-haiku-4-5"></el-input>
          <span class="hint">前台会把这个模型名展示给商户，必须与实际调用的一致</span>
        </el-form-item>
        <el-form-item label="接口地址">
          <el-input v-model="form.endpoint" placeholder="https://..."></el-input>
        </el-form-item>
        <el-form-item label="调用参数">
          <el-input type="textarea" :rows="7" v-model="callParamsText" spellcheck="false"
            placeholder='{"temperature":0,"timeoutMs":12000,"maxRetries":2}'></el-input>
          <span class="hint">
            JSON 对象。timeoutMs 1s~30s；maxRetries 0~2（每次重试都要真花钱，必须封顶）；
            maxInputTokens / maxOutputTokens 为 0 表示不限；temperature 填 null 表示不发送该参数。
          </span>
        </el-form-item>
        <el-form-item label="API Key">
          <el-input v-model="form.apiKey" placeholder="不填则保持原值" show-password></el-input>
        </el-form-item>
        <el-form-item label="Secret">
          <el-input v-model="form.secret" placeholder="需要第二个密钥的通道才填" show-password></el-input>
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
    return { rows: [], meta: {}, visible: false, form: {}, callParamsText: '' }
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
      this.form = Object.assign({}, row, {
        apiKey: '',
        secret: '',
        enabled: row.enabled ? 1 : 0,
        retired: row.retired ? 1 : 0
      })
      // 调用参数用文本编辑，保留 null（= 不发送 temperature）。
      // 直接 JSON.stringify 会把 undefined 丢掉，所以用对象原值 + 2 空格缩进。
      this.callParamsText = JSON.stringify(row.callParams || {}, null, 2)
      this.visible = true
    },
    save() {
      // 先在客户端挡一次 JSON 格式错误，省一次往返；
      // 服务端还会再校验一遍（客户端校验只是体验，不是安全边界）。
      let callParams
      try {
        callParams = this.callParamsText.trim() ? JSON.parse(this.callParamsText) : {}
      } catch (e) {
        this.$message.error('调用参数不是合法 JSON：' + e.message)
        return
      }
      if (callParams === null || typeof callParams !== 'object' || Array.isArray(callParams)) {
        this.$message.error('调用参数必须是 JSON 对象')
        return
      }
      this.postRequest('/admin/engines/save', Object.assign({}, this.form, { callParams })).then(resp => {
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
.hint { margin-left: 8px; color: #909399; font-size: 12px; }
.model-missing { color: #e6a23c; }
</style>
