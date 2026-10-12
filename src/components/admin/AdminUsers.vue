<template>
  <div class="admin-page">
    <div class="admin-bar">
      <el-input v-model="keyword" placeholder="搜索账号/昵称" style="width: 220px" clearable></el-input>
      <el-button type="primary" @click="load">搜索</el-button>
      <el-button type="success" @click="openEdit()">新建商户</el-button>
    </div>
    <el-table :data="rows" v-loading="loading" border stripe>
      <el-table-column prop="id" label="ID" width="80"></el-table-column>
      <el-table-column prop="username" label="账号" width="120"></el-table-column>
      <el-table-column prop="nickname" label="商户名" width="140"></el-table-column>
      <el-table-column prop="basename" label="套餐" width="140"></el-table-column>
      <el-table-column label="类型" width="90">
        <template slot-scope="scope">
          <el-tag :type="scope.row.enterprise ? 'warning' : 'info'" size="mini">{{ scope.row.enterprise ? '企业' : '个人' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="子账号" width="80">
        <template slot-scope="scope">
          <el-button type="text" @click="openSubs(scope.row)">{{ scope.row.subCount || 0 }}</el-button>
        </template>
      </el-table-column>
      <el-table-column prop="charBalance" label="字符余额" width="100"></el-table-column>
      <el-table-column label="自动回复" width="90">
        <template slot-scope="scope">
          <el-tag :type="scope.row.autoReply ? 'success' : 'info'" size="mini">{{ scope.row.autoReply ? '开' : '关' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="到期时间" width="150">
        <template slot-scope="scope">
          <span v-if="!scope.row.expireTime" class="never-expire">无限期</span>
          <span v-else>{{ scope.row.expireTime | formatDateTime }}</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template slot-scope="scope">
          <el-tag :type="scope.row.status === 1 ? 'success' : 'info'">{{ scope.row.status === 1 ? '启用' : '停用' }}</el-tag>
        </template>
      </el-table-column>
      <!--
        操作列原来是并排 7 个文字按钮（width=500）：整个表格因此必须横向滚动，
        而其中真正常用的只有「编辑 / 重置密码」两个。
        这里收成「常用按钮 + 更多菜单」，动作一个没少，表格却不再横向滚动。
      -->
      <el-table-column label="操作" width="180" fixed="right">
        <template slot-scope="scope">
          <el-button type="text" @click="openEdit(scope.row)">编辑</el-button>
          <el-button type="text" @click="openReset(scope.row)">重置密码</el-button>
          <el-dropdown trigger="click" @command="cmd => onAction(cmd, scope.row)">
            <el-button type="text">更多<i class="el-icon-arrow-down el-icon--right"></i></el-button>
            <el-dropdown-menu slot="dropdown">
              <el-dropdown-item :command="'enterprise'">{{ scope.row.enterprise ? '降为个人' : '升企业' }}</el-dropdown-item>
              <!--
                「设为无限期」放在列表里直接给。

                等价能力原先只存在于「编辑」弹窗内的一枚小开关，藏得深，
                超管找不到就会以为后台没这个功能（实际诉求就是这句
                "我没办法去自己改成无限期"）。有到期时间时才显示 ——
                本来就没有到期时间的号，这个动作没有意义。
              -->
              <el-dropdown-item v-if="scope.row.expireTime" :command="'unlimited'">设为无限期</el-dropdown-item>
              <el-dropdown-item :command="'unbind'">踢下线</el-dropdown-item>
              <el-dropdown-item :command="'toggle'">{{ scope.row.status === 1 ? '停用' : '启用' }}</el-dropdown-item>
              <el-dropdown-item :command="'reclaim'">回收字符</el-dropdown-item>
              <el-dropdown-item :command="'delete'" divided>删除</el-dropdown-item>
            </el-dropdown-menu>
          </el-dropdown>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination style="margin-top:12px" :current-page="page" :page-size="rowsPerPage" :total="total"
                   layout="total, prev, pager, next" @current-change="onPage"></el-pagination>

    <el-dialog :title="form.id ? '编辑商户' : '新建商户'" :visible.sync="visible" width="520px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="账号">
          <el-input v-model="form.username" :disabled="!!form.id"></el-input>
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" :placeholder="form.id ? '不填则不修改' : '请输入至少 6 位密码'"></el-input>
        </el-form-item>
        <el-form-item label="商户名">
          <el-input v-model="form.nickname"></el-input>
        </el-form-item>
        <el-form-item label="套餐">
          <el-select v-model="form.versionId" style="width:100%" @change="onPack">
            <el-option v-for="p in packs" :key="p.id" :label="p.title" :value="p.id"></el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="企业账号">
          <el-switch v-model="form.enterprise" :active-value="1" :inactive-value="0" @change="onEnterprise"></el-switch>
          <span class="trial-tip" style="margin-left:8px">{{ form.enterprise ? '企业开子账号不限数量' : '按套餐额度开子账号' }}</span>
        </el-form-item>
        <el-form-item label="子账号额度">
          <el-input-number v-model="form.subQuota" :min="0" :step="1" :disabled="!!form.enterprise"></el-input-number>
          <span class="trial-tip" style="margin-left:8px">
            {{ form.enterprise ? '企业账号不受此额度限制' : '套餐已带默认额度，此处可单独调整' }}
          </span>
        </el-form-item>
        <el-form-item label="到期时间">
          <!--
            @change 是这里的关键，不能省。

            清空日期是用户表达"不要到期时间"的**自然手势**，但如果只是把
            form.expireTime 置空、不同时打开「无限期」开关，保存时服务端会走
            「既没勾无限期也没给日期 → 保持原值」那一分支 —— 日期纹丝不动。
            用户看到的结果就是"我清掉了、保存了、它还在"，于是认定**后台改不了无限期**。
            （jiufa 当初被填成 2038-10-10 这种假日期，正是这条死路的产物。）
            所以清空即视为无限期，让控件行为符合直觉。
          -->
          <el-date-picker v-model="form.expireTime" type="datetime" value-format="yyyy-MM-dd HH:mm:ss"
                          style="width:100%" :disabled="!!form.expireUnlimited"
                          @change="onExpireChange"></el-date-picker>
          <!--
            「无限期」开关：明确、可发现的那条路。
            和上面的清空手势是同一个语义，两条路都通到 expires_at = NULL。
          -->
          <div class="expire-unlimited">
            <el-switch v-model="form.expireUnlimited" :active-value="1" :inactive-value="0"></el-switch>
            <span class="trial-tip" style="margin-left:8px">
              {{ form.expireUnlimited ? '无限期，永不过期' : '到期后自动停用' }}
            </span>
          </div>
        </el-form-item>
        <el-form-item label="联系电话">
          <el-input v-model="form.phone"></el-input>
        </el-form-item>
        <el-form-item label="字符余额">
          <!--
            编辑态必须只读。
            余额只能经「字符调整 / 回收字符」走 char_ledger 变更；服务端
            `/admin/users/save` 里有一条守卫：只要请求带了 charBalance 就 400
            （USE_CHARACTER_GRANT）。而本弹窗原先把余额渲染成可编辑输入框、
            并把它原样回传，导致**每一次「编辑商户」都被这条守卫挡下** ——
            表现就是"能建号、改不了套餐"。这里不只读，save() 里也剔除了该字段。
          -->
          <el-input-number v-model="form.charBalance" :min="0" :step="1000" :disabled="!!form.id"></el-input-number>
          <div v-if="!form.id" class="trial-tip">新商户默认送试用 {{ trialChars }} 字符，可改</div>
          <div v-else class="trial-tip">仅展示。余额调整请用列表里的「回收字符」或后台赠送</div>
        </el-form-item>
        <el-form-item label="自动回复">
          <el-switch v-model="form.autoReply" :active-value="1" :inactive-value="0"></el-switch>
        </el-form-item>
        <el-form-item label="备注">
          <el-input type="textarea" v-model="form.remarks"></el-input>
        </el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="visible=false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </span>
    </el-dialog>

    <el-dialog title="重置密码" :visible.sync="resetVisible" width="440px" @closed="clearReset">
      <p>为 <b>{{ resetRow.username }}</b> 设置新密码（<b>6 位以上</b>，不限字符类型）。</p>
      <p class="dialog-tip">重置后该商户所有已登录的会话会被踢下线，需用新密码重新登录。</p>
      <el-form label-width="70px" style="margin-top:10px">
        <el-form-item label="新密码">
          <el-input v-model="resetPwd" placeholder="请输入至少 6 位密码"></el-input>
        </el-form-item>
        <el-form-item label="确认">
          <el-input v-model="resetPwd2" placeholder="请再次输入新密码"></el-input>
        </el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="resetVisible=false">取消</el-button>
        <el-button type="primary" :loading="resetLoading" @click="submitReset">确认重置</el-button>
      </span>
    </el-dialog>

    <el-dialog :title="(subParent.username || '') + ' 的子账号'" :visible.sync="subVisible" width="720px">
      <el-table :data="subs" border stripe size="small">
        <el-table-column prop="username" label="账号" width="120"></el-table-column>
        <el-table-column prop="nickname" label="姓名" width="120"></el-table-column>
        <el-table-column prop="charBalance" label="字符" width="90"></el-table-column>
        <el-table-column label="聊天号" width="80"><template>不限</template></el-table-column>
        <el-table-column label="电脑" width="90">
          <template slot-scope="scope">{{ scope.row.bound ? '已绑定' : '未绑定' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template slot-scope="scope">{{ scope.row.status === 1 ? '启用' : '停用' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="100">
          <template slot-scope="scope">
            <el-button type="text" @click="unbindSub(scope.row)">踢下线</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <el-dialog title="回收字符" :visible.sync="reclaimVisible" width="460px">
      <p>将把 <b>{{ reclaimRow.username }}</b> 的字符余额 <b>{{ reclaimRow.charBalance || 0 }}</b> 归零。</p>
      <p class="dialog-tip">账号保留。本次回收会写入一条字符流水（correction），事后查得到。</p>
      <el-form label-width="70px" style="margin-top:10px">
        <el-form-item label="备注">
          <el-input v-model="reclaimNote" placeholder="可不填"></el-input>
        </el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="reclaimVisible=false">取消</el-button>
        <el-button type="primary" @click="submitReclaim">确认回收</el-button>
      </span>
    </el-dialog>

    <el-dialog :title="delStep === 1 ? '删除商户（1/2）' : '删除商户（2/2）'"
               :visible.sync="delVisible" width="540px" @closed="resetDelete">
      <template v-if="delStep === 1">
        <p>删除<b>不可恢复</b>。请手工输入账号名以确认：<b>{{ delForm.username }}</b></p>
        <el-input v-model="delForm.confirm" placeholder="输入完整账号名" style="margin-top:8px"></el-input>
        <el-form label-width="70px" style="margin-top:12px">
          <el-form-item label="删除原因">
            <el-input v-model="delForm.reason" placeholder="如：测试账号清理（会写进存档）"></el-input>
          </el-form-item>
        </el-form>
      </template>
      <template v-else>
        <p class="dialog-tip">该商户有业务记录，删除会<b>一并清除且不可恢复</b>：</p>
        <ul class="impact-list">
          <li v-for="row in delImpactRows" :key="row.key">{{ row.label }} <b>{{ row.count }}</b> 条</li>
        </ul>
        <p class="dialog-tip">执行前会把商户行与账目快照存档到「已删除商户」（不挂外键），事后可回溯。</p>
      </template>
      <span slot="footer">
        <el-button @click="delVisible=false">取消</el-button>
        <el-button v-if="delStep === 2" @click="delStep=1">上一步</el-button>
        <el-button type="danger" :disabled="delStep === 1 && !delForm.confirm" @click="submitDelete">
          {{ delStep === 1 ? '下一步' : '确认删除' }}
        </el-button>
      </span>
    </el-dialog>
  </div>
</template>
<script>
// 编辑表单里要把接口回的 ISO 时间串归一成选择器认得的 `yyyy-MM-dd HH:mm:ss`。
// 全局过滤器 `formatDateTime` 只在模板里可用，JS 里要用得显式 import。
import { formatDateTime } from '../../utils/filters'

export default {
  data() {
    return {
      keyword: '',
      loading: false,
      rows: [],
      page: 1,
      rowsPerPage: 10,
      total: 0,
      visible: false,
      packs: [],
      trialChars: 10000,
      form: {},
      subVisible: false,
      subParent: {},
      subs: [],
      reclaimVisible: false,
      reclaimRow: {},
      reclaimNote: '',
      delVisible: false,
      delStep: 1,
      delForm: { id: null, username: '', confirm: '', reason: '' },
      delRemoved: {},
      // 重置密码弹窗
      resetVisible: false,
      resetRow: {},
      resetPwd: '',
      resetPwd2: '',
      resetLoading: false
    }
  },
  computed: {
    // 删除确认弹窗第二步要展示"到底会删掉什么"。
    // 这些条数是服务端在 409 响应里带回来的（NEED_ACKNOWLEDGE），
    // 不是前端估算 —— 以数据库实际行的 count 为准。
    delImpactRows() {
      const labels = {
        recharges: '充值单', translate_logs: '翻译记录', translation_reservations: '翻译预留',
        translation_usage: '翻译用量', orders: '工单', character_transfers: '字符划转',
        char_ledger: '字符流水', sub_accounts: '子账号', conversations: '会话', messages: '消息',
        customer_merchant_links: '客户绑定', customer_owners: '客户归属', scripts: '脚本',
        login_logs: '登录日志', short_links: '短链', identity_match_events: '身份匹配'
      }
      return Object.keys(this.delRemoved || {})
        .filter(key => Number(this.delRemoved[key]) > 0)
        .map(key => ({ key, label: labels[key] || key, count: Number(this.delRemoved[key]) }))
    }
  },
  mounted() {
    this.getRequest('/admin/packages').then(resp => { if (resp) this.packs = resp.data })
    this.getRequest('/admin/settings').then(resp => {
      if (resp && resp.data && resp.data.trialChars !== undefined) this.trialChars = Number(resp.data.trialChars)
    })
    this.load()
  },
  methods: {
    load() {
      this.loading = true
      this.getRequest('/admin/users', { page: this.page, rows: this.rowsPerPage, keyword: this.keyword }).then(resp => {
        this.loading = false
        if (resp && resp.status == 200) {
          this.rows = resp.data.rows
          this.total = resp.data.total
        }
      }).catch(() => { this.loading = false })
    },
    onPage(page) {
      this.page = page
      this.load()
    },
    /**
     * 「更多」下拉的派发。
     * 把这些动作收进菜单只是为了让表格不再横向滚动，
     * 能力与原来的并排按钮完全一致 —— 没有功能被藏起来之后消失。
     */
    onAction(cmd, row) {
      const handlers = {
        enterprise: () => this.setEnterprise(row),
        unlimited: () => this.setUnlimited(row),
        unbind: () => this.unbind(row),
        toggle: () => this.toggle(row),
        reclaim: () => this.reclaim(row),
        delete: () => this.openDelete(row)
      }
      const handler = handlers[cmd]
      if (handler) handler()
    },
    /**
     * 一键设为无限期。
     *
     * 走独立的 `/admin/users/expiry` 而不是复用 `/admin/users/save`：
     * 后者要求带上 `versionId` 并按整套字段更新，从列表一键触发太重、
     * 也容易顺手改掉别的列。独立接口只碰 `expires_at` 一列 ——
     * 与 `/admin/users/resetPassword`（"只做一件事：不碰套餐/状态/到期"）
     * 是同一个思路：动作越窄，越不可能误伤。
     */
    setUnlimited(row) {
      this.$confirm(`把「${row.username}」设为无限期（永不过期）？`, '设为无限期', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }).then(() => this.postRequest('/admin/users/expiry', { id: row.id }).then(resp => {
        const data = resp.data || {}
        // HTTP 层的错误由 axios 拦截器统一提示；这里处理的是 200 里的业务失败，
        // 不能一律当成功弹 —— 那会让人以为改好了，其实没有。
        if (data.success === 'error') {
          this.$message.error(data.msg || '设置失败')
          return
        }
        this.$message.success(data.msg || '已设为无限期')
        this.load()
      })).catch(() => {})
    },
    /**
     * 到期时间选择器的 @change。
     *
     * 清空日期 == 不要到期时间 == 无限期。必须在这里把开关同步打开，
     * 否则保存时服务端走「保持原值」分支，日期原样留着 ——
     * 用户的体感就是"清掉了却改不动"，进而认定后台没有设置无限期的能力。
     */
    onExpireChange(value) {
      this.form.expireUnlimited = value ? 0 : 1
    },
    onPack(id) {
      const pack = this.packs.find(p => p.id === id)
      if (!pack) return
      this.form.port = pack.port
      // 换套餐时把该套餐自带的子账号额度带出来，省得超管还要去翻套餐配置。
      // 企业账号不受额度限制，不去覆盖它的值。
      if (!this.form.enterprise) this.form.subQuota = Number(pack.subQuota || 0)
    },
    onEnterprise(value) {
      // 升企业：额度框会被置灰，值保持不动（降回来时还是它）。
      // 降为个人：按当前套餐把额度恢复成默认，否则会沿用"无限"时的残留值。
      if (Number(value) === 1) return
      const pack = this.packs.find(p => p.id === this.form.versionId)
      if (pack) this.form.subQuota = Number(pack.subQuota || 0)
    },
    openEdit(row) {
      if (row) {
        /**
         * 布尔列必须归一成 0/1。
         *
         * 列表接口回的是 Postgres 布尔（`true`/`false`），而下面两个开关用的是
         * `:active-value="1"`。`true !== 1`，所以**开关永远渲染成「关」** ——
         * 哪怕库里明明是开的。表现就是"打开→保存→再打开还是关的"，
         * 让人以为没保存成功（实际上早就存进去了，生产上连点了三次）。
         *
         * 顺带也避免把布尔 `true` 原样提交：`encodeForm` 会把它序列化成字符串
         * `"true"`，服务端 `Number("true")` 是 NaN，会被判成 false —— 那就会
         * **真的**把企业账号关掉。
         */
        this.form = Object.assign({}, row, {
          password: '',
          enterprise: Number(row.enterprise) ? 1 : 0,
          autoReply: Number(row.autoReply) ? 1 : 0,
          // 到期时间必须**归一成选择器认识的格式**再塞进表单。
          //
          // 列表接口回的是 Postgres timestamptz 经 JSON 序列化后的 ISO 串
          // （`2038-10-10T16:42:04.000Z`），而上面 el-date-picker 的 value-format
          // 是 `yyyy-MM-dd HH:mm:ss`。Element UI 解析失败时会**原样回显这个串**
          // （见 node_modules/element-ui/.../picker.vue 里
          // `parseAsFormatAndType(...) || this.value`），于是编辑框里显示的是一段
          // ISO 原文而不是日期 —— 用户以为这个字段坏了，就去手动清它。
          // 走 formatDateTime 还顺带把时区对齐成列表那一列的口径，两处显示一致。
          expireTime: row.expireTime ? formatDateTime(row.expireTime) : '',
          // 没有到期时间 == 无限期。不这么归一的话，编辑一个不过期的商户时
          // 开关会显示为「关」，保存后服务端按"保持原值"处理，看不出问题，
          // 但超管会误以为这个号是有到期时间的。
          expireUnlimited: row.expireTime ? 0 : 1
        })
      } else {
        // 新建：默认取第一个套餐自带的端口与子账号额度，省一步手填
        const first = this.packs[0] || {}
        this.form = {
          versionId: first.id || 1,
          port: Number(first.port || 0),
          status: 1,
          charBalance: this.trialChars,
          autoReply: 0,
          enterprise: 0,
          subQuota: Number(first.subQuota || 0),
          // 新建默认仍是 30 天（服务端 COALESCE 兜底），要用「无限期」需显式打开
          expireUnlimited: 0
        }
      }
      this.visible = true
    },
    openSubs(row) {
      this.subParent = row
      this.getRequest('/admin/subs', { userId: row.id }).then(resp => {
        this.subs = resp && resp.data ? (resp.data.rows || []) : []
        this.subVisible = true
      })
    },
    setEnterprise(row) {
      const enterprise = row.enterprise ? 0 : 1
      this.postRequest('/admin/users/enterprise', { id: row.id, enterprise }).then(resp => {
        this.$message.success(resp.data.msg)
        this.load()
      })
    },
    unbind(row) {
      this.postRequest('/admin/users/unbind', { id: row.id }).then(resp => {
        this.$message.success(resp.data.msg)
        this.load()
      })
    },
    unbindSub(row) {
      this.postRequest('/admin/users/unbind', { subId: row.id }).then(resp => {
        this.$message.success(resp.data.msg)
        this.openSubs(this.subParent)
      })
    },
    save() {
      // 编辑时**绝不能**回传 charBalance。
      // 服务端 `/admin/users/save` 有一条守卫：请求带 charBalance 就 400
      // （USE_CHARACTER_GRANT），因为余额只能经 char_ledger 变更。
      // 原先本方法直接提交整个 form，而 form 里始终有 charBalance ——
      // 于是「编辑商户」必然失败，表现就是"能建号、改不了套餐"。
      const payload = Object.assign({}, this.form)
      if (payload.id) delete payload.charBalance
      this.postRequest('/admin/users/save', payload).then(resp => {
        this.$message({ type: resp.data.success, message: resp.data.msg })
        if (resp.data.success !== 'error') {
          this.visible = false
          this.load()
        }
      })
    },
    openReset(row) {
      this.resetRow = row
      this.resetPwd = ''
      this.resetPwd2 = ''
      this.resetVisible = true
    },
    clearReset() {
      this.resetPwd = ''
      this.resetPwd2 = ''
      this.resetLoading = false
    },
    submitReset() {
      // 前端先挡一道省一次往返；真正的规则以服务端为准（6-128 位，见 lib/password.js）
      if (!this.resetPwd || String(this.resetPwd).length < 6) {
        this.$message.error('密码至少需要 6 位')
        return
      }
      if (String(this.resetPwd) !== String(this.resetPwd2)) {
        this.$message.error('两次输入的密码不一致')
        return
      }
      this.resetLoading = true
      // 走只做一件事的独立接口：不碰套餐/状态/到期等其它字段
      this.postRequest('/admin/users/resetPassword', { id: this.resetRow.id, password: this.resetPwd })
        .then(resp => {
          this.resetLoading = false
          this.$message({ type: resp.data.success, message: resp.data.msg })
          if (resp.data.success !== 'error') {
            this.resetVisible = false
            this.load()
          }
        })
        .catch(() => { this.resetLoading = false })
    },
    toggle(row) {
      const status = row.status === 1 ? 0 : 1
      this.postRequest('/admin/users/status', { id: row.id, status }).then(() => this.load())
    },
    reclaim(row) {
      this.reclaimRow = row
      this.reclaimNote = ''
      this.reclaimVisible = true
    },
    submitReclaim() {
      this.postRequest('/admin/users/reclaim', { id: this.reclaimRow.id, note: this.reclaimNote }).then(resp => {
        this.$message.success(resp.data.msg)
        this.reclaimVisible = false
        this.load()
      }).catch(() => {})
    },
    openDelete(row) {
      this.delForm = { id: row.id, username: row.username, confirm: '', reason: '' }
      this.delRemoved = {}
      this.delStep = 1
      this.delVisible = true
    },
    resetDelete() {
      this.delForm = { id: null, username: '', confirm: '', reason: '' }
      this.delRemoved = {}
      this.delStep = 1
    },
    submitDelete() {
      const payload = {
        id: this.delForm.id,
        confirmUsername: this.delForm.confirm,
        reason: this.delForm.reason
      }
      // 第二步才带 acknowledge：服务端据此判断"操作人已经看过影响清单"。
      if (this.delStep === 2) payload.acknowledge = true
      // silent：409 的 msg 是"要不要继续"的中间态，不该被拦成一条红色错误提示。
      this.postRequest('/admin/users/delete', payload, { silent: true }).then(resp => {
        this.$message.success(resp.data.msg)
        this.delVisible = false
        this.load()
      }).catch(error => {
        const data = (error.response && error.response.data) || {}
        if (data.code === 'NEED_ACKNOWLEDGE') {
          this.delRemoved = (data.details && data.details.removed) || {}
          this.delStep = 2
          return
        }
        this.$message.error(data.msg || '删除失败')
      })
    }
  }
}
</script>
<style scoped>
.admin-page { text-align: left; }
.trial-tip { color: var(--w-text-faint); font-size: 12px; line-height: 1.4; }
.admin-bar { margin-bottom: 12px; }
.danger-link { color: #f56c6c; }
.dialog-tip { color: var(--w-text-faint); font-size: 12px; line-height: 1.6; }
.impact-list { margin: 10px 0; padding-left: 18px; font-size: 13px; line-height: 1.8; }
.never-expire { color: var(--w-text-faint); }
.expire-unlimited { margin-top: 6px; display: flex; align-items: center; }
</style>
