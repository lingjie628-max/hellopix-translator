<template>
  <div class="admin-page">
    <el-alert
      :title="meta.note || '加载中…'"
      :type="meta.smtpReady ? 'success' : 'error'"
      show-icon :closable="false" style="margin-bottom:12px">
      <div v-if="!meta.smtpReady && missingText" class="tip-body">
        缺少：{{ missingText }}。
        <b>补齐即可生效</b> —— 注册与找回密码会自动恢复，不需要重启服务。
      </div>
      <div v-else-if="meta.smtpReady" class="tip-body">
        邮箱通道已接通，注册与找回密码可正常发信。建议点下方「配置」里的测试发信实测一次。
      </div>
    </el-alert>

    <el-table :data="rows" border stripe>
      <el-table-column prop="name" label="通道" width="140"></el-table-column>
      <el-table-column prop="kind" label="类型" width="80"></el-table-column>
      <el-table-column label="当前实现" width="140">
        <template slot-scope="scope">{{ providerText(scope.row) }}</template>
      </el-table-column>
      <el-table-column label="接口" width="90">
        <template slot-scope="scope">
          <el-tag :type="scope.row.wired ? 'success' : 'info'" size="mini">{{ scope.row.wiredText }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="配置" width="70">
        <template slot-scope="scope">{{ scope.row.hasKey ? '已填' : '空' }}</template>
      </el-table-column>
      <el-table-column prop="note" label="说明" min-width="200" show-overflow-tooltip></el-table-column>
      <el-table-column label="操作" width="90">
        <template slot-scope="scope">
          <el-button type="text" @click="edit(scope.row)">配置</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog title="配置验证码接口" :visible.sync="visible" width="580px">
      <el-form :model="form" label-width="120px">
        <el-form-item label="通道">{{ form.name }}</el-form-item>
        <el-form-item v-if="form.id === 'email'" label="发送方式">
          <el-select v-model="form.provider" style="width:100%">
            <el-option label="SMTP（真实发信）" value="smtp"></el-option>
            <el-option label="本地演示（不发信）" value="local"></el-option>
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.id === 'email'" label="演示带出验证码">
          <el-switch v-model="form.revealDemo" :active-value="1" :inactive-value="0"></el-switch>
          <span style="margin-left:8px;color:var(--w-text-faint);font-size:12px">仅本地演示有效</span>
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
          <el-input-number v-model="form.digits" :min="4" :max="8"></el-input-number>
        </el-form-item>

        <template v-if="form.id === 'email' && form.provider === 'smtp'">
          <el-divider content-position="left">SMTP 凭据（与「邮件服务」页共用同一份配置）</el-divider>
          <el-form-item label="SMTP 主机">
            <el-input v-model="form.smtpHost" placeholder="smtp.resend.com"></el-input>
          </el-form-item>
          <el-form-item label="端口">
            <el-input-number v-model="form.smtpPort" :min="1" :max="65535"></el-input-number>
            <el-checkbox :checked="!!form.smtpSecure" style="margin-left:12px"
                         @change="v => form.smtpSecure = v ? 1 : 0">SSL/TLS</el-checkbox>
            <div class="hint">465 用 SSL（勾选），587 用 STARTTLS（取消勾选）</div>
          </el-form-item>
          <el-form-item label="SMTP 账号">
            <el-input v-model="form.smtpUser" placeholder="Resend 填 resend"></el-input>
          </el-form-item>
          <el-form-item label="SMTP 密码">
            <el-input v-model="form.smtpPass" type="password" show-password
                      :placeholder="form.hasKey ? '已配置，留空则不修改' : '粘贴服务商 API Key / 授权码'"></el-input>
            <div class="hint">保存后读取只回「已配置」，绝不回传明文</div>
          </el-form-item>
          <el-form-item label="发件人">
            <el-input v-model="form.smtpFrom" placeholder="noreply@pixfanyi.com"></el-input>
            <div class="hint">该域名必须先在服务商后台完成 SPF / DKIM 验证，否则会进垃圾箱或被拒收</div>
          </el-form-item>
          <el-alert v-if="!form.wired && form.missing && form.missing.length"
                    type="warning" :closable="false" show-icon style="margin-bottom:12px"
                    :title="'当前还缺：' + form.missing.join('、')"></el-alert>
        </template>

        <el-form-item v-if="form.id !== 'email'" label="接口地址">
          <el-input v-model="form.endpoint" placeholder="第三方短信 API，接入后再填"></el-input>
        </el-form-item>
        <el-form-item v-if="form.id !== 'email'" label="API Key">
          <el-input v-model="form.apiKey" placeholder="不填则保持原值" show-password></el-input>
        </el-form-item>
        <el-form-item label="备注">
          <el-input type="textarea" v-model="form.note"></el-input>
        </el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="visible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </span>
    </el-dialog>
  </div>
</template>
<script>
export default {
  name: 'AdminVerify',
  data() {
    return { rows: [], meta: {}, visible: false, form: {}, saving: false }
  },
  computed: {
    missingText() {
      const email = (this.rows || []).find(r => r.id === 'email')
      return email && email.missing ? email.missing.join('、') : ''
    }
  },
  mounted() { this.load() },
  methods: {
    providerText(row) {
      if (row.id === 'email') return row.providerName || 'SMTP'
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
      // smtpPass 置空：后端把「空」当作"不改口令"，避免把掩码当成新密码存进去
      this.form = Object.assign({}, row, { apiKey: '', secret: '', smtpPass: '' })
      this.visible = true
    },
    save() {
      this.saving = true
      this.postRequest('/admin/verify/save', this.form).then(resp => {
        if (!resp) return
        this.$message.success(resp.data.msg || '已保存')
        this.visible = false
        this.load()
      }).finally(() => { this.saving = false })
    }
  }
}
</script>
<style scoped>
.admin-page { text-align: left; }
.tip-body { font-size: 12px; line-height: 1.7; }
.hint { margin-top: 4px; color: var(--w-text-faint); font-size: 12px; }
</style>
