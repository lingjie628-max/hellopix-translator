<template>
  <div class="admin-page">
    <el-alert type="warning" :closable="false" show-icon style="margin-bottom:16px">
      <template slot="title">跨商户检测默认关闭，开启前必须先取得商户书面同意</template>
      <div class="tip-body">
        开启后，系统会告诉商户「该客户正被平台其他销售跟进」，<b>但不会透露对方是谁、是哪家、聊了什么</b>。
        这条边界由服务端强制：跨商户返回体里根本没有对方标识，不是靠前端隐藏。
        <br>
        未取得同意就开启 = 拿 A 商户的客户资源去提示 B 商户 —— 这会让平台失去信任基础。
      </div>
    </el-alert>

    <el-card>
      <div slot="header">撞单规则</div>
      <el-form :model="form" label-width="180px" style="max-width:640px">
        <el-form-item label="同商户撞单检测">
          <el-switch v-model="form.sameMerchant"></el-switch>
          <span class="hint">同一商户内多个客服跟进同一客户时提醒</span>
        </el-form-item>
        <el-form-item label="跨商户撞单检测">
          <el-switch v-model="form.crossMerchant"></el-switch>
          <span class="hint">默认关闭。开启后双方都只收到匿名提示</span>
        </el-form-item>
        <el-form-item label="撞单处理方式">
          <el-radio-group v-model="form.notifyMode">
            <el-radio label="warn">只提醒（warn）</el-radio>
            <el-radio label="block">阻止发送（block）</el-radio>
            <el-radio label="takeover">允许强制接管（takeover）</el-radio>
          </el-radio-group>
          <div class="hint">
            建议先用 <b>warn</b>：误报时不会挡住正常工作。
            跑一段时间看真实误报率，再决定是否升级为 block。
          </div>
        </el-form-item>
        <el-form-item label="无活动自动释放">
          <el-input-number v-model="form.ownerIdleReleaseDays" :min="1" :max="365"></el-input-number>
          <span class="hint">天。超过这个天数没有互动的跟进关系回归公共池</span>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="saving" @click="save">保存规则</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card style="margin-top:16px">
      <div slot="header">撞单历史（最近 100 条）</div>
      <el-table :data="history" v-loading="loading" size="small">
        <el-table-column prop="detected_at" label="时间" width="180"></el-table-column>
        <el-table-column prop="public_id" label="客户" width="130"></el-table-column>
        <el-table-column label="类型" width="120">
          <template slot-scope="s">
            <el-tag :type="s.row.kind === 'cross_merchant' ? 'warning' : 'danger'" size="mini">
              {{ s.row.kind === 'cross_merchant' ? '跨商户' : '同商户' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="resolution" label="处理结果" width="140">
          <template slot-scope="s">
            <el-tag :type="s.row.resolution === 'pending' ? 'info' : 'success'" size="mini">
              {{ s.row.resolution === 'pending' ? '待处理' : s.row.resolution }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="涉及商户" min-width="160">
          <template slot-scope="s">#{{ s.row.existing_user_id }} → #{{ s.row.new_user_id }}</template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && !history.length" description="暂无撞单记录"></el-empty>
    </el-card>
  </div>
</template>

<script>
export default {
  name: 'AdminCollision',
  data() {
    return {
      form: { sameMerchant: true, crossMerchant: false, notifyMode: 'warn', ownerIdleReleaseDays: 30 },
      history: [],
      loading: false,
      saving: false
    }
  },
  mounted() { this.load() },
  methods: {
    load() {
      this.loading = true
      Promise.all([
        this.getRequest('/admin/collision-settings'),
        this.getRequest('/admin/collisions')
      ]).then(([cfg, hist]) => {
        if (cfg && cfg.data) Object.assign(this.form, cfg.data)
        if (hist && hist.data) this.history = hist.data.rows || []
      }).finally(() => { this.loading = false })
    },
    save() {
      this.saving = true
      this.putRequest('/admin/collision-settings', this.form)
        .then(resp => {
          if (!resp) return
          this.$message({ type: 'success', message: '规则已保存' })
        }).finally(() => { this.saving = false })
    }
  }
}
</script>

<style scoped>
.admin-page { text-align: left; }
.tip-body { font-size: 12px; line-height: 1.7; }
.hint { margin-left: 10px; color: var(--w-text-faint); font-size: 12px; }
</style>
