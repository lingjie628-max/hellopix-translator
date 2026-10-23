<template>
  <div class="admin-page">
    <!--
      ★ 读取失败必须与"未配置"区分开 ★
      两者都表现为表单空白，但结论完全相反：
      一个是"去填一份配置"，另一个是"别动，配置好好的，是读取出了问题"。
      混在一起会让人去覆盖一份正确的配置。
    -->
    <el-alert v-if="loadError" type="warning" :closable="false" show-icon style="margin-bottom:16px">
      <template slot="title">读不到当前配置 —— 下面的表单是空的，不代表没配</template>
      <div class="tip-body">
        原因：{{ loadError }}<br>
        <b>请勿直接保存</b>，否则会用空值覆盖线上正在生效的配置。
        先刷新页面重试；仍有问题查服务端日志。
      </div>
    </el-alert>
    <el-alert v-else-if="!configured" type="error" :closable="false" show-icon style="margin-bottom:16px">
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
      loading: false,
      loadError: '',
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
      this.loading = true
      this.loadError = ''
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
      }).catch(err => {
        // ★ 读取失败必须**显式说出来**，不能让它看起来像"没配置" ★
        //
        // 2026-10-23：GET /admin/mail 因为二次认证判定错误回 428，
        // 前端在 `if (!resp) return` 处静默返回，表单保持初始空值，
        // 顶部红条显示"邮件服务未配置 / 缺：未知"。
        // 运维看到这页会以为配置丢了，实际库里数据完好（vlen=179）。
        //
        // 空表单 + "未配置" 是最坏的误导：它会让人去重填一份已经正确的配置。
        this.loadError = (err && err.response && err.response.data && err.response.data.msg)
          || (err && err.message) || '加载失败'
      }).finally(() => { this.loading = false })
    },
    save() {
      // 读不到现有配置时禁止保存：表单是空的，提交等于把线上配置清空。
      if (this.loadError) {
        return this.$message({ type: 'warning', message: '尚未成功读取现有配置，请先刷新页面，避免用空值覆盖' })
      }
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
