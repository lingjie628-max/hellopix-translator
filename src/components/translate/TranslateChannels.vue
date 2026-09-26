<template>
  <div class="engine-page">
    <el-alert
      v-if="!canSwitch"
      title="当前套餐已为你选好翻译通道，如需自行切换请升级套餐"
      type="info" show-icon :closable="false" style="margin-bottom:16px">
    </el-alert>
    <el-alert
      v-else
      title="只有已接通的通道可以选用；标注「即将上线」的通道尚未接通，暂不可选。"
      type="info" show-icon :closable="false" style="margin-bottom:16px">
    </el-alert>
    <div class="engine-meta">
      当前套餐 <b>{{ meta.packageTitle }}</b>
      · 字符余额 <b>{{ meta.charBalance || 0 }}</b>
      · 正在使用 <b>{{ activeName }}</b>
      <!--
        把真实调用的模型摆给商户看。这不是"技术细节"：不同模型的成本与质量
        差好几倍，商户有权知道自己花的字符落在哪个模型上；
        对我们也是约束 —— 前台写着 A、后台偷偷调 B 这种事，显示出来就做不了了。
      -->
      <span v-if="meta.activeModel"> · 模型 <b>{{ meta.activeModel }}</b></span>
    </div>
    <el-alert
      title="换通道后重新翻译属于一次新的翻译，会再次扣除字符；同一段文本用同一通道重试不会重复扣费。"
      type="warning" show-icon :closable="false" style="margin-bottom:16px">
    </el-alert>
    <el-row :gutter="16">
      <el-col :span="8" v-for="item in rows" :key="item.id">
        <el-card shadow="hover" :class="{ locked: !item.allowed, current: item.active }">
          <div class="engine-name">{{ item.name }}</div>
          <div class="engine-provider">{{ item.provider }} · {{ tierText(item.tier) }}</div>
          <div class="engine-model" v-if="item.model">模型：{{ item.model }}</div>
          <div class="engine-note">{{ item.note }}</div>
          <div class="engine-foot">
            <el-tag size="mini" :type="item.wired ? 'success' : 'info'">{{ item.wiredText }}</el-tag>
            <el-tag v-if="item.active" size="mini" type="danger">当前</el-tag>
            <el-tag v-if="item.comingSoon" size="mini" type="info">即将上线</el-tag>
            <el-tag v-else-if="!item.allowed" size="mini" type="warning">套餐未包含</el-tag>
          </div>
          <el-button
            type="primary"
            size="small"
            style="width:100%;margin-top:12px"
              :disabled="!canSwitch || !item.allowed || item.active"
            @click="choose(item)">
              {{ buttonText(item) }}
          </el-button>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>
<script>
export default {
  data() {
    return { rows: [], meta: {}, canSwitch: true }
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
      return { basic: '基础档', advanced: '高级档', pro: '专业档' }[tier] || tier
    },
    // 按钮文案要区分"套餐里没有（升级才可用）"和"套餐里有但没接通（即将上线）"——
    // 后者写"升级套餐后可用"是错的：升级了也用不了，只会让人白升一次。
    buttonText(item) {
      if (!this.canSwitch) return item.active ? '当前使用中' : '套餐固定'
      if (item.active) return '已选择'
      if (item.comingSoon) return '即将上线'
      return item.allowed ? '设为当前通道' : '升级套餐后可用'
    },
    load() {
      this.getRequest('/translate/engines').then(resp => {
        if (!resp) return
        this.rows = resp.data.rows || []
          this.meta = resp.data
          this.canSwitch = resp.data.canSwitch !== false
      })
    },
    choose(item) {
      this.postRequest('/translate/engines/active', { id: item.id }).then(resp => {
        this.$message({ type: resp.data.success === 'error' ? 'error' : 'success', message: resp.data.msg })
        if (resp.data.success !== 'error') this.load()
      })
    }
  }
}
</script>
<style scoped>
.engine-page { text-align: left; }
.engine-meta { margin-bottom: 16px; color: var(--w-text-muted); }
.el-card { margin-bottom: 16px; }
.engine-name { font-size: 18px; font-weight: 700; color: var(--w-text-strong); }
.engine-provider { color: var(--w-text-faint); font-size: 12px; margin: 6px 0 10px; }
.engine-model { color: var(--w-text-muted); font-size: 12px; font-family: ui-monospace, Menlo, monospace; margin-bottom: 8px; }
.engine-note { color: var(--w-text-muted); font-size: 13px; min-height: 44px; }
.engine-foot { margin-top: 10px; }
.locked { opacity: 0.72; }
.current { border-color: #fca5a5; }
</style>
