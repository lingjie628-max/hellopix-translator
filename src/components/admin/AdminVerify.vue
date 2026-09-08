<template>
  <div class="admin-page">
    <el-alert
      :title="meta.msg || '验证码接口板块已就位，邮件发送尚未接入。密钥和 SMTP 可先填。'"
      type="info" show-icon :closable="false" style="margin-bottom:12px">
    </el-alert>
    <el-table :data="rows" border stripe>
      <el-table-column prop="name" label="通道" width="140"></el-table-column>
      <el-table-column prop="kind" label="类型" width="80"></el-table-column>
      <el-table-column label="当前实现" width="110">
        <template slot-scope="scope">{{ providerText(scope.row) }}</template>
      </el-table-column>
      <el-table-column label="接口" width="90">
        <template slot-scope="scope">
          <el-tag :type="scope.row.wired ? 'success' : 'info'" size="mini">{{ scope.row.wiredText }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="配置" width="80">
        <template slot-scope="scope">{{ scope.row.hasKey ? '已填' : '空' }}</template>
      </el-table-column>
      <el-table-column prop="note" label="说明" min-width="220" show-overflow-tooltip></el-table-column>
      <el-table-column label="操作" width="90">
        <template slot-scope="scope">
          <el-button type="text" @click="edit(scope.row)">配置</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog title="配置验证码接口" :visible.sync="visible" width="560px">
      <el-form :model="form" label-width="120px">
        <el-form-item label="通道">{{ form.name }}</el-form-item>
        <el-form-item v-if="form.id === 'email'" label="发送方式">
          <el-select v-model="form.provider" style="width:100%">
            <el-option label="本地演示（不发信）" value="local"></el-option>
            <el-option label="SMTP（后续接入）" value="smtp"></el-option>
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.id === 'email'" label="演示带出验证码">
          <el-switch v-model="form.revealDemo" :active-value="1" :inactive-value="0"></el-switch>
          <span style="margin-left:8px;color:#909399;font-size:12px">仅本地演示有效</span>
        </el-form-item>
        <el-form-item v-if="form.id === 'email'" label="重发间隔">
          <el-input-number v-model="form.resendSeconds" :min="10" :max="300"></el-input-number>
          <span style="margin-left:8px">秒</span>
        </el-form-item>
        <el-form-item label="有效期">
          <el-input-number v-model="form.expireMin" :min="1" :max="60"></el-input-number>
          <span style="margin-left:8px">分钟</span>
        </el-form-item>
        <el-form-item label="位数">
          <el-input-number v-model="form.length" :min="4" :max="8"></el-input-number>
        </el-form-item>
        <template v-if="form.id === 'email' && form.provider === 'smtp'">
          <el-form-item label="SMTP 主机">
            <el-input v-model="form.smtpHost" placeholder="例如 smtp.example.com"></el-input>
          </el-form-item>
          <el-form-item label="端口">
            <el-input-number v-model="form.smtpPort" :min="1" :max="65535"></el-input-number>
          </el-form-item>
          <el-form-item label="SSL">
            <el-switch v-model="form.smtpSecure" :active-value="1" :inactive-value="0"></el-switch>
          </el-form-item>
          <el-form-item label="SMTP 账号">
            <el-input v-model="form.smtpUser" placeholder="发信账号，后续接入用"></el-input>
          </el-form-item>
          <el-form-item label="SMTP 密码">
            <el-input v-model="form.smtpPass" placeholder="不填则保持原值" show-password></el-input>
          </el-form-item>
          <el-form-item label="发件人">
            <el-input v-model="form.smtpFrom" placeholder="可空，默认用账号"></el-input>
          </el-form-item>
        </template>
        <el-form-item label="接口地址">
          <el-input v-model="form.endpoint" placeholder="第三方图验或云邮件 API，后续接入再填"></el-input>
        </el-form-item>
        <el-form-item label="API Key">
          <el-input v-model="form.apiKey" placeholder="不填则保持原值" show-password></el-input>
        </el-form-item>
        <el-form-item v-if="form.id === 'email'" label="Secret">
          <el-input v-model="form.secret" placeholder="云厂商需要时再填" show-password></el-input>
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
  mounted() { this.load() },
  methods: {
    providerText(row) {
      if (row.id === 'email') return row.providerName || row.provider || '本地演示'
      return row.provider === 'local' ? '本地 SVG' : (row.provider || '本地')
    },
    load() {
      this.getRequest('/admin/verify').then(resp => {
        if (!resp) return
        this.rows = resp.data.rows || []
        this.meta = resp.data
      })
    },
    edit(row) {
      this.form = Object.assign({}, row, { apiKey: '', secret: '', smtpPass: '' })
      this.visible = true
    },
    save() {
      this.postRequest('/admin/verify/save', this.form).then(resp => {
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
