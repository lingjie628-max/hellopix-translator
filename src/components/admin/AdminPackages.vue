<template>
  <div class="admin-page">
    <!--
      新增入口。后端很早就能创建（package-service.js 里 `data.id ? 更新 : 插入`），
      但前端只做了「编辑」，于是套餐种类实际被写死成初始那三档 ——
      想涨价、想加个企业档，都只能改库。
    -->
    <div class="toolbar">
      <el-button type="primary" icon="el-icon-plus" @click="create">新增套餐</el-button>
      <span class="toolbar-tip">
        新增的套餐会立刻出现在官网定价页和商户充值页（按「排序」从小到大排列）。
      </span>
    </div>
    <el-table :data="rows" border stripe>
      <el-table-column prop="id" label="ID" width="60"></el-table-column>
      <el-table-column prop="code" label="标识" width="120"></el-table-column>
      <el-table-column prop="title" label="套餐" width="160"></el-table-column>
      <!-- 货币单位跟随后台「系统设置 → 价格货币」，不再写死"元" -->
      <el-table-column :label="'价格(' + currencyName + ')'" width="120">
        <template slot-scope="scope">{{ currencySymbol }} {{ scope.row.price }}</template>
      </el-table-column>
      <el-table-column label="字符" width="100">
        <template slot-scope="scope">{{ (scope.row.chars || 0) / 10000 }} 万</template>
      </el-table-column>
      <!--
        单位价列：这一列的存在就是为了让"阶梯非单调"自己暴露出来。
        生产上曾经是 23.33 / 26.00 / 20.83 —— 高级版比基础版还贵，
        而这个错误靠人眼看"35 / 65 / 125"和"250万 / 600万"两组数字是发现不了的。
        单位价沿档位必须严格下降，`npm run check:plan-copy` 会在 CI 里拦。
      -->
      <el-table-column label="单位价" width="150">
        <template slot-scope="scope">
          <span :class="{ 'unit-bad': !unitOk(scope.row) }">{{ unitOf(scope.row) || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="子账号" width="80">
        <template slot-scope="scope">{{ Number(scope.row.subQuota || 0) }} 个</template>
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
          <el-tag v-for="id in (scope.row.engines || [])" :key="id" size="mini"
                  :type="wiredOf(id) ? '' : 'info'"
                  :title="wiredOf(id) ? '' : '未接通：客户选中后会翻译失败，建议先摘除'"
                  style="margin: 0 4px 4px 0">{{ nameOf(id) }}<template v-if="!wiredOf(id)">（未接通）</template></el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150">
        <template slot-scope="scope">
          <el-button type="text" @click="edit(scope.row)">编辑</el-button>
          <el-button type="text" class="danger-text" @click="retire(scope.row)">下架</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-dialog :title="isNew ? '新增套餐' : '编辑套餐'" :visible.sync="visible" width="620px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="标识">
          <el-input v-model="form.code" :disabled="!isNew" placeholder="例如 pro / vip_360d"
                    style="width:260px"></el-input>
          <!--
            标识创建后不可改：它可能已经被订单快照、结算逻辑、官网文案引用。
            改名字是安全的，改标识等于换了个东西。
          -->
          <div class="unit-tip">
            2-64 位小写字母/数字/下划线/横线，以字母开头。<b>创建后不能改</b>。
          </div>
        </el-form-item>
        <el-form-item label="名称"><el-input v-model="form.title" placeholder="例如 专业版"></el-input></el-form-item>
        <el-form-item label="说明"><el-input v-model="form.subtitle"></el-input></el-form-item>
        <el-form-item label="价格">
          <el-input-number v-model="form.price" :min="0" :precision="2" :step="10"></el-input-number>
          <span class="unit-tip">{{ currencyName }}（{{ currencySymbol }}）· 币种在「系统设置 → 价格货币」切换</span>
        </el-form-item>
        <el-form-item label="字符数"><el-input-number v-model="form.chars" :min="0" :step="150000"></el-input-number></el-form-item>
        <el-form-item label="子账号额度">
          <el-input-number v-model="form.subQuota" :min="0" :step="1"></el-input-number>
          <span class="unit-tip">
            该档套餐可开的子账号数。买这一档充值到账时会写进商户的额度；
            企业账号不受此限制。
          </span>
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sortOrder" :min="0" :step="10"></el-input-number>
          <span class="unit-tip">
            官网定价页按这个从小到大排。一般按价格从低到高，填 10 / 20 / 30 即可。
          </span>
        </el-form-item>
        <el-form-item label="客户端">
          <el-checkbox :value="!!(form.clients && form.clients.standalone)" @change="val => setClient('standalone', val)">独立应用版</el-checkbox>
          <el-checkbox :value="!!(form.clients && form.clients.mobile)" @change="val => setClient('mobile', val)">手机版</el-checkbox>
          <el-checkbox :value="!!(form.clients && form.clients.counter)" @change="val => setClient('counter', val)">计数器版本</el-checkbox>
        </el-form-item>
        <el-form-item label="翻译通道">
          <el-checkbox-group v-model="form.engines">
            <el-checkbox v-for="item in engineList" :key="item.id" :label="item.id" style="width: 46%; margin: 4px 0">
              {{ item.name }}<span v-if="item.wired === false" class="coming-soon">（即将上线）</span>
            </el-checkbox>
          </el-checkbox-group>
          <div class="coming-soon-tip">
            标「即将上线」的通道还没配凭据，客户选中它会翻译失败。想让它真正可用，先去
            「翻译通道」页填凭据并设为接通。
          </div>
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
// 单位价算法唯一真源：官网定价卡、商户充值页、本表三处共用一份
import { formatUnitPrice, unitPricePerMillion } from '../../utils/plan-value'

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
      isNew: false,
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
    /** 单位价：与官网定价卡、商户充值页共用同一份算法（src/utils/plan-value） */
    unitOf(row) {
      return formatUnitPrice(row.price, row.chars, this.currencySymbol)
    },
    /**
     * 这一档的单位价是否比低一档便宜。
     *
     * 不比它便宜就是**阶梯断了**（生产上真出现过：高级版比基础版贵 11.4%）。
     * 返回 false 时那一格标红，"哪一档配错了"一眼可见。
     * 与 `npm run check:plan-copy` 的单调性校验是同一个判据。
     */
    unitOk(row) {
      const priced = this.rows
        .map(r => ({ row: r, unit: unitPricePerMillion(r.price, r.chars), price: Number(r.price) }))
        .filter(x => x.unit !== null)
        .sort((a, b) => a.price - b.price)
      const at = priced.findIndex(x => String(x.row.id) === String(row.id))
      if (at <= 0) return true // 最便宜的那一档没有"低一档"可比
      return priced[at].unit < priced[at - 1].unit
    },
    // 未接通的通道是"套餐里有、但翻不了"的：选中它必然 503，客户只看到"没有译文"。
    // 在套餐编辑处标出来，避免再配出一个"配了却不能翻"的套餐。
    wiredOf(id) {
      const item = this.engineList.find(e => e.id === id)
      return !item || item.wired !== false
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
    /**
     * 新建：给一份空表单。
     *
     * 刻意**不带 id**，`save()` 里会据此走插入分支。
     * 排序默认取"最后一个 + 10"，新增的档位自然排在末尾 ——
     * 绝大多数情况你要加的正是更贵的那一档。
     */
    create() {
      const last = this.rows.reduce((max, r) => Math.max(max, Number(r.sortOrder) || 0), 0)
      this.isNew = true
      this.form = {
        code: '',
        title: '',
        subtitle: '',
        price: 0,
        chars: 0,
        subQuota: 0,
        sortOrder: last + 10,
        engines: [],
        clients: { standalone: 0, mobile: 0, counter: 0 },
        features: {}
      }
      this.visible = true
    },
    edit(row) {
      this.isNew = false
      this.form = Object.assign({}, row, {
        features: Object.assign({}, row.features || {}),
        engines: (row.engines || []).slice(),
        clients: Object.assign({ standalone: 0, mobile: 0, counter: 0 }, row.clients || {})
      })
      this.visible = true
    },
    save() {
      const payload = Object.assign({}, this.form, {
        features: JSON.stringify(this.form.features || {}),
        engines: JSON.stringify(this.form.engines || []),
        clients: JSON.stringify(this.form.clients || {})
      })
      // ★ 新建必须把 id 剥掉 ★
      //
      // 后端的判据就是 `data.id ? 更新 : 插入`。`this.form` 是浅拷贝自某个
      // row 的话（比如先点编辑又点新增但表单没重置），残留的 id 会让
      // "新增"变成"覆盖掉那个已有套餐"，而且响应还会提示"套餐已创建"之外的信息 ——
      // 数据已经错了，提示再准也没用。
      if (this.isNew) delete payload.id
      this.postRequest('/admin/packages/save', payload).then(resp => {
        if (!resp) return
        this.$message.success(resp.data.msg)
        this.visible = false
        this.load()
      })
    },
    /**
     * 下架（软删）。
     *
     * 不做物理删除：已买过这一档的商户，历史订单、账单、已发的字符额度
     * 都还引用着它的 title/price。硬删会让历史记录变成空白。
     * 置 active=false 后，官网定价页、商户充值页、新购入口都不再出现它。
     */
    retire(row) {
      this.$confirm(
        `下架「${row.title}」？\n\n` +
        '下架后：官网定价页、充值页不再显示这一档，新用户买不到。\n' +
        '已经买过它的商户不受影响，历史订单照常显示。',
        '下架套餐',
        { type: 'warning', confirmButtonText: '下架', cancelButtonText: '取消' }
      ).then(() => {
        return this.postRequest('/admin/packages/retire', { id: row.id })
      }).then(resp => {
        if (!resp) return
        this.$message.success(resp.data.msg || '已下架')
        this.load()
      }).catch(() => { /* 用户取消 */ })
    }
  }
}
</script>
<style scoped>
.admin-page { text-align: left; }
.unit-tip { margin-left: 10px; color: var(--w-text-faint); font-size: 12px; }
/* 阶梯断了的那一档标红：不用去比三组数字，哪一行配错一眼可见 */
.unit-bad { color: var(--w-danger); font-weight: 600; }
.coming-soon { color: var(--w-text-faint); font-size: 12px; }
.coming-soon-tip { margin-top: 6px; color: var(--w-text-faint); font-size: 12px; line-height: 1.6; }
</style>
