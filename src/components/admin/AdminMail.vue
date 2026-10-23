<template>
  <div class="admin-page">
    <el-alert v-if="!configured" type="error" :closable="false" show-icon style="margin-bottom:16px">
      <template slot="title">邮件服务未配置 —— 商户无法注册、无法找回密码</template>
      <div class="tip-body">
        缺：{{ missing.join('、') || '未知' }}。<br>
        推荐用现成的邮件推送服务（阿里云邮件推送 / 腾讯云 SES / SendGrid），
        它们都提供 SMTP 入口，比自建 SMTP 可靠得多 —— <b>自建发件很容易进垃圾箱</b>，
        而验证邮件进垃圾箱等于注册功能不可用。
      </div>
    </el-alert>
    <el-alert v-else type="success" :closable="false" show-icon style="margin-bottom:16px">
      <template slot="title">邮件服务已就绪</template>
      <div class="tip-body">注册与找回密码可用。建议填一个收件地址点「发送测试邮件」实测一次。</div>
    </el-alert>

    <el-card>
      <div slot="header">SMTP 配置</div>
      <el-form :model="form" label-width="140px" style="max-width:680px">
        <el-form-item label="SMTP 服务器">
          <el-input v-model="form.host" placeholder="smtpdm.aliyun.com"></el-input>
        </el-form-item>
        <el-form-item label="端口">
          <el-input-number v-model="form.port" :min="1" :max="65535"></el-input-number>
          <el-checkbox v-model="form.secure" style="margin-left:12px">SSL/TLS</el-checkbox>
          <div class="hint">465 用 SSL，587 用 STARTTLS（此时取消勾选）</div>
        </el-form-item>
        <el-form-item label="账号">
          <el-input v-model="form.user" placeholder="通常是发件邮箱全称"></el-input>
        </el-form-item>
        <el-form-item label="密码 / 授权码">
          <el-input v-model="form.pass" type="password" show-password
                    placeholder="多数服务商要求用「授权码」而不是登录密码"></el-input>
          <div class="hint">保存后读取会打码显示，不会回传明文</div>
        </el-form-item>
        <el-form-item label="发件地址">
          <el-input v-model="form.from" placeholder="noreply@yourdomain.com"></el-input>
          <div class="hint">
            必须在该服务商后台完成<b>域名验证（SPF / DKIM）</b>，
            否则邮件会进垃圾箱甚至被拒收
          </div>
        </el-form-item>
        <el-form-item label="告警收件地址">
          <el-input v-model="form.alertTo" :placeholder="alertToPlaceholder" style="width:280px"></el-input>
          <div class="hint">
            服务异常、备份失败、磁盘告急会发到这里。**不填就没有告警** ——
            出问题时只能等用户投诉才知道。
            <br>
            <b>出于隐私保护，这里只显示打码后的地址。留空保存 = 保持原值不变。</b>
          </div>
        </el-form-item>
        <el-form-item label="发件人名称">
          <el-input v-model="form.fromName" placeholder="Hello Pix" style="width:240px"></el-input>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="saving" @click="save">保存</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card style="margin-top:16px">
      <div slot="header">测试发信</div>
      <div class="test-row">
        <el-input v-model="testTo" placeholder="收件邮箱" style="width:280px"></el-input>
        <el-button :loading="testing" @click="test">发送测试邮件</el-button>
        <span class="hint">
          「只验证连接」不够 —— 最常见的故障是连接正常但邮件进垃圾箱，
          所以这里直接真发一封
        </span>
      </div>

      <!-- 结果常驻显示：toast 一闪而过，排障时看不到细节 -->
      <el-alert v-if="testResult" style="margin-top:12px" :closable="false" show-icon
                :type="testResult.ok ? 'success' : 'error'"
                :title="testResult.msg">
        <div class="tip-body">
          <div v-if="testResult.code && !testResult.ok">
            错误码：<b>{{ testResult.code }}</b>
            <span v-if="testResult.stage">（卡在 {{ stageText(testResult.stage) }} 这一步）</span>
          </div>
          <div v-if="testResult.detail" style="margin-top:4px;word-break:break-all">
            服务端应答：{{ testResult.detail }}
          </div>
          <div v-if="testResult.messageId" style="margin-top:4px;word-break:break-all">
            messageId：{{ testResult.messageId }}
          </div>
        </div>
      </el-alert>
    </el-card>
  </div>
</template>

<script>
export default {
  name: 'AdminMail',
  data() {
    return {
      form: { host: '', port: 465, secure: true, user: '', pass: '', from: '', fromName: 'Hello Pix', alertTo: '' },
      configured: false,
      missing: [],
      saving: false,
      testing: false,
      testTo: '',
      testResult: null,
      // 打码后的现有告警地址，只用于 placeholder 提示，不参与提交
      alertToPlaceholder: 'ops@yourdomain.com'
    }
  },
  mounted() { this.load() },
  methods: {
    load() {
      this.getRequest('/admin/mail').then(resp => {
        if (!resp) return
        // alertTo 服务端返回的是**打码值**（li***@gmail.com），不能当真实地址回填，
        // 否则管理员改个端口一保存，数据库里存的就变成打码串，告警邮件全部退回。
        // 打码值只放在 placeholder 里提示"现在配的是谁"，输入框保持空 = 不改。
        const maskedAlertTo = resp.data.alertTo || ''
        const { alertTo: _omit, ...rest } = resp.data
        Object.assign(this.form, rest)
        this.form.alertTo = ''
        this.alertToPlaceholder = maskedAlertTo
          ? `当前：${maskedAlertTo}（留空则不变）`
          : 'ops@yourdomain.com'
        this.configured = !!resp.data.configured
        this.missing = resp.data.missing || []
      })
    },
    save() {
      this.saving = true
      // 空字符串在后端表示"保持原值"（见 content.js 的 alertTo 处理）
      const payload = { ...this.form }
      if (!payload.alertTo) delete payload.alertTo
      this.postRequest('/admin/mail', payload).then(resp => {
        if (!resp) return
        this.configured = !!resp.data.configured
        this.$message({ type: 'success', message: '已保存' })
        this.load()
      }).finally(() => { this.saving = false })
    },
    test() {
      if (!this.testTo) return this.$message({ type: 'warning', message: '请先填收件邮箱' })
      this.testing = true
      this.testResult = null
      // 失败时后端返回非 2xx + 结构化错误体，axios 会 reject；
      // 这里两个分支都要接住，否则真实的错误码就丢了。
      this.postRequest('/admin/mail/test', { to: this.testTo }).then(resp => {
        if (!resp) return
        this.testResult = resp.data || { ok: false, msg: '服务端没有返回结果' }
      }).catch(err => {
        const body = (err && err.response && err.response.data) || {}
        this.testResult = body.msg
          ? body
          : { ok: false, code: 'REQUEST_FAILED', msg: (err && err.message) || '请求失败' }
      }).finally(() => { this.testing = false })
    },
    stageText(stage) {
      return { config: '读取配置', input: '校验收件人', connect: '连接/认证', deliver: '投递', done: '完成' }[stage] || stage
    }
  }
}
</script>

<style scoped>
.admin-page { text-align: left; }
.tip-body { font-size: 12px; line-height: 1.7; }
.hint { margin-left: 10px; color: var(--w-text-faint); font-size: 12px; }
.test-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
</style>
