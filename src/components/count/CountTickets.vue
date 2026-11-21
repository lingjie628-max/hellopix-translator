<template>
  <div class="count-page">
    <section class="count-hero">
      <div>
        <div class="count-kicker">COUNT DESK</div>
        <h1>计数工单</h1>
        <p>绑定客户端实际上报的接入账号后，系统按会话去重计粉。同一客户换账号再次进入，自动记为重粉。</p>
      </div>
      <div v-if="counterSuite" class="count-hero-actions">
        <el-button icon="el-icon-folder-opened" @click="openGroupManager">命名分组</el-button>
        <el-button icon="el-icon-upload2" @click="openBaseManager">底库管理</el-button>
        <el-button type="primary" icon="el-icon-plus" @click="openTicketForm()">新建计数工单</el-button>
      </div>
    </section>

    <section v-if="!counterSuite" class="count-locked">
      <div class="count-locked-mark">PRO</div>
      <div>
        <h2>当前套餐未开通计数工单</h2>
        <p>Hello Pix 高级版可以继续使用翻译与多开；计数工单、新粉/重粉统计和自动工单需要升级专业版。</p>
      </div>
      <el-button type="primary" @click="$router.push('/user/rechargePage')">查看套餐</el-button>
    </section>

    <template v-else>
    <section class="count-panel">
      <div class="count-toolbar">
        <el-input
          v-model="filters.keyword"
          clearable
          placeholder="搜索工单名称"
          prefix-icon="el-icon-search"
          @keyup.enter.native="search"
          @clear="search"
        ></el-input>
        <el-select v-model="filters.status" clearable placeholder="全部状态" @change="search">
          <el-option label="进行中" value="active"></el-option>
          <el-option label="已关闭" value="closed"></el-option>
        </el-select>
        <el-button @click="search">查询</el-button>
        <span class="count-rule">会话去重 · 消息不重复灌水 · 重粉按工单范围识别</span>
      </div>

      <el-table v-if="rows.length" :data="rows" v-loading="loading" border stripe>
        <el-table-column label="工单" min-width="210">
          <template slot-scope="scope">
            <button class="count-title" type="button" @click="openDetail(scope.row)">
              <span>{{ scope.row.title }}</span>
              <small>#{{ scope.row.id }}</small>
            </button>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="92">
          <template slot-scope="scope">
            <el-tag :type="scope.row.status === 'active' ? 'success' : 'info'" size="mini">
              {{ scope.row.status === 'active' ? '进行中' : '已关闭' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="计数应用" width="145">
          <template slot-scope="scope">
            <span>{{ platformName(scope.row.platform) }}</span>
            <small class="count-scope">{{ dedupScopeLabel(scope.row.dedupScope) }}</small>
            <small v-if="scope.row.groupName" class="count-scope">{{ scope.row.groupName }}</small>
            <small v-if="scope.row.dedupBaseEnabled" class="count-scope count-base-mark">含底库</small>
          </template>
        </el-table-column>
        <el-table-column prop="accountCount" label="账号" width="76" align="center"></el-table-column>
        <el-table-column label="累计进粉" width="104" align="right">
          <template slot-scope="scope"><b class="count-number">{{ scope.row.totalFans }}</b></template>
        </el-table-column>
        <el-table-column label="今日进粉" width="104" align="right">
          <template slot-scope="scope"><b class="count-number">{{ scope.row.todayFans }}</b></template>
        </el-table-column>
        <el-table-column label="累计重粉" width="104" align="right">
          <template slot-scope="scope"><b class="count-number count-repeat">{{ scope.row.repeatFans }}</b></template>
        </el-table-column>
        <el-table-column label="今日重粉" width="104" align="right">
          <template slot-scope="scope"><b class="count-number count-repeat">{{ scope.row.todayRepeatFans }}</b></template>
        </el-table-column>
        <el-table-column label="单日 / 总目标" min-width="132">
          <template slot-scope="scope">{{ scope.row.dayTarget }} / {{ scope.row.totalTarget }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template slot-scope="scope">
            <el-button type="text" @click="openDetail(scope.row)">明细</el-button>
            <el-button type="text" @click="openTicketForm(scope.row)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="!loading && !rows.length" class="count-empty-onboarding">
        <div class="count-empty-mark">01</div>
        <div class="count-empty-copy">
          <h3>还没有计数工单</h3>
          <p>计数工单不是自动出现的。先新建一张工单并绑定客户端已上报的接入账号，之后真实入站会话才会开始计粉。</p>
          <div class="count-empty-steps">
            <span>1. 新建计数工单</span>
            <span>2. 打开对应应用会话</span>
            <span>3. 绑定接入账号</span>
            <span>4. 等真实客户入站</span>
          </div>
        </div>
        <el-button type="primary" icon="el-icon-plus" @click="openTicketForm()">新建第一张工单</el-button>
      </div>
      <el-pagination
        v-if="total > filters.rows"
        class="count-pagination"
        :current-page="filters.page"
        :page-size="filters.rows"
        :total="total"
        layout="total, prev, pager, next"
        @current-change="changePage"
      ></el-pagination>
    </section>

    <el-drawer
      :visible.sync="detailVisible"
      size="82%"
      :with-header="false"
      custom-class="count-drawer"
    >
      <div v-if="ticket" v-loading="detailLoading" class="count-detail">
        <header class="count-detail-head">
          <div>
            <div class="count-kicker">TICKET #{{ ticket.id }}</div>
            <h2>{{ ticket.title }}</h2>
            <p>
              {{ platformName(ticket.platform) }} · {{ dedupScopeLabel(ticket.dedupScope) }}
              <template v-if="ticket.groupId"> · {{ ticketGroupName(ticket.groupId) }}</template>
              <template v-if="ticket.dedupBaseEnabled"> · 含底库</template>
              · 业务日从 {{ ticket.zeroTime }} 开始 · {{ ticket.timezone }}
            </p>
          </div>
          <div class="count-detail-actions">
            <el-tag :type="ticket.status === 'active' ? 'success' : 'info'">
              {{ ticket.status === 'active' ? '进行中' : '已关闭' }}
            </el-tag>
            <el-button icon="el-icon-edit" @click="openTicketForm(ticket)">编辑</el-button>
            <el-button type="primary" icon="el-icon-plus" :disabled="ticket.status !== 'active'" @click="openAccountForm">
              绑定账号
            </el-button>
          </div>
        </header>

        <section class="count-metrics">
          <div class="metric-card metric-primary"><span>今日进粉</span><b>{{ metrics.todayFans || 0 }}</b></div>
          <div class="metric-card"><span>今日新粉</span><b>{{ metrics.todayNewFans || 0 }}</b></div>
          <div class="metric-card metric-repeat"><span>今日重粉</span><b>{{ metrics.todayRepeatFans || 0 }}</b></div>
          <div class="metric-card"><span>累计进粉</span><b>{{ metrics.totalFans || 0 }}</b></div>
          <div class="metric-card"><span>累计新粉</span><b>{{ metrics.newFans || 0 }}</b></div>
          <div class="metric-card metric-repeat"><span>累计重粉</span><b>{{ metrics.repeatFans || 0 }}</b></div>
        </section>

        <section class="count-section">
          <div class="count-section-head">
            <div>
              <h3>绑定账号</h3>
              <p>一个客户端接入账号同时只能属于一个进行中的计数工单。</p>
            </div>
          </div>
          <el-table :data="accounts" size="small" border>
            <el-table-column label="平台" min-width="150">
              <template slot-scope="scope">{{ platformName(scope.row.platform) }}</template>
            </el-table-column>
            <el-table-column prop="accountKey" label="账号" min-width="180" show-overflow-tooltip></el-table-column>
            <el-table-column label="状态" width="82">
              <template slot-scope="scope">
                <el-tag :type="scope.row.active ? 'success' : 'info'" size="mini">
                  {{ scope.row.active ? '计数中' : '已停用' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="todayFans" label="今日" width="78" align="right"></el-table-column>
            <el-table-column prop="totalFans" label="累计" width="78" align="right"></el-table-column>
            <el-table-column prop="repeatFans" label="重粉" width="78" align="right"></el-table-column>
            <el-table-column label="操作" width="84" align="right">
              <template slot-scope="scope">
                <el-button
                  v-if="scope.row.active"
                  type="text"
                  class="count-danger"
                  @click="deactivate(scope.row)"
                >停用</el-button>
              </template>
            </el-table-column>
          </el-table>
        </section>

        <section class="count-section">
          <div class="count-section-head count-fans-head">
            <div>
              <h3>粉丝明细</h3>
              <p>一行代表一条真实会话，不会按消息条数重复计数。</p>
            </div>
            <div class="count-fan-filters">
              <el-select v-model="fanFilters.type" size="small" @change="loadFans(1)">
                <el-option label="全部" value="all"></el-option>
                <el-option label="新粉" value="new"></el-option>
                <el-option label="重粉" value="repeat"></el-option>
              </el-select>
              <el-select v-model="fanFilters.repeatType" size="small" @change="loadFans(1)">
                <el-option label="全部依据" value="all"></el-option>
                <el-option label="进线重粉" value="fan"></el-option>
                <el-option label="底库重粉" value="base"></el-option>
              </el-select>
              <el-input
                v-model="fanFilters.keyword"
                size="small"
                clearable
                placeholder="账号或昵称"
                @keyup.enter.native="loadFans(1)"
                @clear="loadFans(1)"
              ></el-input>
              <el-button size="small" @click="loadFans(1)">查询</el-button>
            </div>
          </div>
          <el-table :data="fans" size="small" border>
            <el-table-column label="类型" width="82">
              <template slot-scope="scope">
                <el-tag :type="scope.row.fanType === 'repeat' ? 'warning' : 'success'" size="mini">
                  {{ scope.row.fanType === 'repeat' ? '重粉' : '新粉' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="重粉依据" width="96">
              <template slot-scope="scope">
                <span>{{ scope.row.fanType === 'repeat' ? (scope.row.repeatType === 'base' ? '底库' : '进线') : '—' }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="displayName" label="昵称" min-width="130" show-overflow-tooltip>
              <template slot-scope="scope">{{ scope.row.displayName || '—' }}</template>
            </el-table-column>
            <el-table-column prop="peerKey" label="客户标识" min-width="160" show-overflow-tooltip></el-table-column>
            <el-table-column prop="customerPublicId" label="客户编号" width="110"></el-table-column>
            <el-table-column label="平台" width="140">
              <template slot-scope="scope">{{ platformName(scope.row.platform) }}</template>
            </el-table-column>
            <el-table-column prop="accountKey" label="接入账号" min-width="150" show-overflow-tooltip></el-table-column>
            <el-table-column label="进粉时间" width="168">
              <template slot-scope="scope">{{ formatTime(scope.row.eventAt) }}</template>
            </el-table-column>
          </el-table>
          <el-empty v-if="!fans.length" description="还没有粉丝记录"></el-empty>
          <el-pagination
            v-if="fanTotal > fanFilters.rows"
            class="count-pagination"
            :current-page="fanFilters.page"
            :page-size="fanFilters.rows"
            :total="fanTotal"
            layout="total, prev, pager, next"
            @current-change="loadFans"
          ></el-pagination>
        </section>
      </div>
    </el-drawer>

    <el-dialog
      :title="ticketForm.id ? '编辑计数工单' : '新建计数工单'"
      :visible.sync="ticketDialog"
      width="640px"
      :close-on-click-modal="false"
    >
      <el-form label-width="92px">
        <el-form-item label="工单名称">
          <el-input v-model="ticketForm.title" maxlength="120" show-word-limit></el-input>
        </el-form-item>
        <el-form-item label="计数应用">
          <el-select
            v-model="ticketForm.platform"
            filterable
            style="width:100%"
            :disabled="ticketForm.dedupLocked"
            @change="handleTicketPlatformChange"
          >
            <el-option v-for="p in platformOptions" :key="p.id" :label="p.name" :value="p.id"></el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="查重范围">
          <el-select
            v-model="ticketForm.dedupScope"
            style="width:100%"
            :disabled="ticketForm.dedupLocked"
            @change="handleDedupScopeChange"
          >
            <el-option label="同商户全部工单" value="merchant"></el-option>
            <el-option label="仅当前工单" value="ticket"></el-option>
            <el-option label="命名分组内" value="group"></el-option>
            <el-option label="指定关联工单" value="linked"></el-option>
          </el-select>
          <p class="count-form-tip count-scope-tip">
            {{ dedupScopeDescription(ticketForm.dedupScope) }}
          </p>
        </el-form-item>
        <el-form-item label="命名分组">
          <el-select
            v-model="ticketForm.groupId"
            clearable
            filterable
            style="width:100%"
            placeholder="可选择本应用的命名分组"
            :disabled="ticketForm.dedupLocked"
          >
            <el-option
              v-for="group in groupOptions"
              :key="group.id"
              :label="group.name + '（' + group.ticketCount + ' 个工单）'"
              :value="group.id"
            ></el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="底库去重">
          <el-switch
            v-model="ticketForm.dedupBaseEnabled"
            :disabled="ticketForm.dedupLocked"
            active-text="命中底库记为重粉"
          ></el-switch>
          <p class="count-form-tip count-scope-tip">
            只比较本商户、本应用导入的底库线索；不同应用和不同商户互不影响。
          </p>
        </el-form-item>
        <el-form-item
          v-if="ticketForm.dedupScope === 'linked'"
          label="关联工单"
        >
          <el-select
            v-model="ticketForm.linkedTicketIds"
            v-loading="dedupOptionsLoading"
            multiple
            filterable
            collapse-tags
            style="width:100%"
            placeholder="选择参与查重的其它工单"
            :disabled="ticketForm.dedupLocked"
          >
            <el-option
              v-for="item in dedupOptions"
              :key="item.id"
              :label="'#' + item.id + ' ' + item.title"
              :value="item.id"
            ></el-option>
          </el-select>
          <p v-if="!dedupOptionsLoading && !dedupOptions.length" class="count-form-tip">
            当前应用还没有其它工单，请先创建目标工单再设置关联。
          </p>
        </el-form-item>
        <el-alert
          v-if="ticketForm.dedupLocked"
          title="该工单已有进粉记录，查重范围、分组、底库、计数应用和关联工单已锁定。"
          type="info"
          :closable="false"
          show-icon
        ></el-alert>
        <el-form-item label="状态">
          <el-radio-group v-model="ticketForm.status">
            <el-radio-button label="active">进行中</el-radio-button>
            <el-radio-button label="closed">已关闭</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="单日目标">
          <el-input-number v-model="ticketForm.dayTarget" :min="0" :max="1000000"></el-input-number>
        </el-form-item>
        <el-form-item label="总目标">
          <el-input-number v-model="ticketForm.totalTarget" :min="0" :max="1000000000"></el-input-number>
        </el-form-item>
        <el-form-item label="业务时区">
          <el-select v-model="ticketForm.timezone" filterable allow-create style="width:100%">
            <el-option v-for="z in timezones" :key="z" :label="z" :value="z"></el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="每日置零">
          <el-input v-model="ticketForm.zeroTime" placeholder="00:00:00"></el-input>
        </el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="ticketDialog = false">取消</el-button>
        <el-button type="primary" :loading="savingTicket" @click="saveTicket">保存</el-button>
      </span>
    </el-dialog>

    <el-dialog
      title="命名邀请码分组"
      :visible.sync="groupDialog"
      width="720px"
      :close-on-click-modal="false"
    >
      <el-form :inline="true" label-width="72px" class="count-inline-form">
        <el-form-item label="应用">
          <el-select v-model="groupForm.platform" style="width:180px" @change="loadGroups">
            <el-option v-for="p in platformOptions" :key="p.id" :label="p.name" :value="p.id"></el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="分组名">
          <el-input v-model="groupForm.name" maxlength="80" placeholder="例如：马来 A 组"></el-input>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="groupSaving" @click="saveGroup">
            {{ groupForm.id ? '保存修改' : '创建分组' }}
          </el-button>
          <el-button v-if="groupForm.id" @click="resetGroupForm">取消编辑</el-button>
        </el-form-item>
      </el-form>
      <p class="count-form-tip">分组只允许同一商户、同一应用；组内查重会读取该组全部工单的历史进粉。</p>
      <el-table :data="groups" size="small" border v-loading="groupsLoading">
        <el-table-column prop="name" label="分组名称" min-width="180"></el-table-column>
        <el-table-column label="应用" width="150">
          <template slot-scope="scope">{{ platformName(scope.row.platform) }}</template>
        </el-table-column>
        <el-table-column prop="ticketCount" label="工单数" width="82" align="right"></el-table-column>
        <el-table-column prop="activeTicketCount" label="进行中" width="82" align="right"></el-table-column>
        <el-table-column label="操作" width="130" align="right">
          <template slot-scope="scope">
            <el-button type="text" @click="editGroup(scope.row)">编辑</el-button>
            <el-button type="text" class="count-danger" @click="deleteGroup(scope.row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!groupsLoading && !groups.length" description="当前应用还没有命名分组"></el-empty>
      <span slot="footer"><el-button @click="groupDialog = false">关闭</el-button></span>
    </el-dialog>

    <el-dialog
      title="底库管理"
      :visible.sync="baseDialog"
      width="880px"
      :close-on-click-modal="false"
    >
      <div class="count-base-head">
        <el-select v-model="baseForm.platform" style="width:190px" @change="refreshBase">
          <el-option v-for="p in platformOptions" :key="p.id" :label="p.name" :value="p.id"></el-option>
        </el-select>
        <div class="count-base-stat">
          <span>底库线索</span><b>{{ baseStats.totalEntries || 0 }}</b>
        </div>
        <div class="count-base-stat">
          <span>最近导入</span><b class="count-base-time">{{ formatTime(baseStats.lastImportedAt) }}</b>
        </div>
        <el-button class="count-danger" :loading="baseClearing" @click="clearBase">清空当前应用</el-button>
      </div>

      <div class="count-base-import">
        <div class="count-base-import-head">
          <div>
            <h3>导入原始线索</h3>
            <p>一行一条：用户名----昵称----来源。单次最多 1000 条，大文件会在前端自动分批。</p>
          </div>
          <div>
            <input
              ref="baseFileInput"
              type="file"
              accept=".txt,.csv,text/plain,text/csv"
              class="count-file-input"
              @change="readBaseFile"
            >
            <el-button size="small" @click="$refs.baseFileInput.click()">选择 TXT / CSV</el-button>
          </div>
        </div>
        <el-input
          v-model="baseForm.text"
          type="textarea"
          :rows="7"
          placeholder="628123456789----客户昵称----WhatsApp&#10;628987654321----另一个客户"
        ></el-input>
        <div class="count-base-import-actions">
          <span v-if="baseForm.filename">文件：{{ baseForm.filename }}</span>
          <el-button type="primary" :loading="baseImporting" :disabled="!baseForm.text.trim()" @click="importBase">
            导入底库
          </el-button>
        </div>
      </div>

      <div class="count-base-list">
        <div class="count-base-list-head">
          <h3>最近导入明细</h3>
          <el-input
            v-model="baseFilters.keyword"
            size="small"
            clearable
            placeholder="搜索用户名或昵称"
            @keyup.enter.native="loadBaseEntries(1)"
            @clear="loadBaseEntries(1)"
          ></el-input>
          <el-button size="small" @click="loadBaseEntries(1)">查询</el-button>
        </div>
        <el-table :data="baseEntries" size="small" border>
          <el-table-column prop="peerKey" label="用户名 / 平台ID" min-width="180" show-overflow-tooltip></el-table-column>
          <el-table-column prop="displayName" label="昵称" min-width="140" show-overflow-tooltip></el-table-column>
          <el-table-column prop="source" label="来源" min-width="110" show-overflow-tooltip></el-table-column>
          <el-table-column prop="batchId" label="批次" width="80" align="right"></el-table-column>
          <el-table-column label="导入时间" width="168">
            <template slot-scope="scope">{{ formatTime(scope.row.importedAt) }}</template>
          </el-table-column>
        </el-table>
        <el-pagination
          v-if="baseEntryTotal > baseFilters.rows"
          class="count-pagination"
          :current-page="baseFilters.page"
          :page-size="baseFilters.rows"
          :total="baseEntryTotal"
          layout="total, prev, pager, next"
          @current-change="loadBaseEntries"
        ></el-pagination>
      </div>
      <span slot="footer"><el-button @click="baseDialog = false">关闭</el-button></span>
    </el-dialog>

    <el-dialog title="绑定接入账号" :visible.sync="accountDialog" width="480px" :close-on-click-modal="false">
      <el-form label-width="82px">
        <el-form-item label="平台">
          <el-input :value="ticket ? platformName(ticket.platform) : ''" disabled></el-input>
        </el-form-item>
        <el-form-item label="接入账号">
          <el-select
            v-model="accountForm.accountKey"
            filterable
            default-first-option
            style="width:100%"
            placeholder="选择客户端已上报账号"
          >
            <el-option
              v-for="item in availableAccountOptions"
              :key="item.platform + ':' + item.accountKey"
              :label="platformName(item.platform) + ' · ' + item.accountKey + '（' + item.conversationCount + ' 会话）'"
              :value="item.accountKey"
            ></el-option>
          </el-select>
        </el-form-item>
      </el-form>
      <p v-if="!availableAccountOptions.length" class="count-form-tip">
        还没有可绑定账号。请先在客户端打开该应用的一个会话，让客户端上报接入账号。
      </p>
      <p v-else class="count-form-tip">这里选择客户端主进程实际上报的接入账号；它可能不是 WhatsApp 手机号。</p>
      <span slot="footer">
        <el-button @click="accountDialog = false">取消</el-button>
        <el-button
          type="primary"
          :loading="savingAccount"
          :disabled="!accountForm.accountKey"
          @click="saveAccount"
        >绑定</el-button>
      </span>
    </el-dialog>
    </template>
  </div>
</template>

<script>
export default {
  data() {
    return {
      loading: false,
      rows: [],
      total: 0,
      filters: { keyword: '', status: '', page: 1, rows: 30 },
      detailVisible: false,
      detailLoading: false,
      ticket: null,
      metrics: {},
      accounts: [],
      dedupTicketIds: [],
      fans: [],
      fanTotal: 0,
      fanFilters: { type: 'all', repeatType: 'all', keyword: '', page: 1, rows: 20 },
      platforms: [],
      ticketDialog: false,
      savingTicket: false,
      ticketForm: {},
      dedupOptions: [],
      dedupOptionsLoading: false,
      groups: [],
      groupOptions: [],
      groupsLoading: false,
      groupDialog: false,
      groupSaving: false,
      groupForm: { id: null, name: '', platform: 'whatsapp-green' },
      baseDialog: false,
      baseForm: { platform: 'whatsapp-green', filename: '', text: '' },
      baseStats: { totalEntries: 0, lastImportedAt: null },
      baseEntries: [],
      baseEntryTotal: 0,
      baseFilters: { platform: 'whatsapp-green', keyword: '', page: 1, rows: 20 },
      baseImporting: false,
      baseClearing: false,
      accountDialog: false,
      savingAccount: false,
      accountForm: { platform: 'whatsapp-green', accountKey: '' },
      availableAccounts: [],
      timezones: [
        'Asia/Shanghai',
        'Asia/Hong_Kong',
        'Asia/Singapore',
        'Asia/Kuala_Lumpur',
        'Asia/Bangkok',
        'Asia/Jakarta',
        'Asia/Manila',
        'Asia/Tokyo',
        'America/New_York',
        'America/Los_Angeles',
        'Europe/London',
        'UTC'
      ]
    }
  },
  computed: {
    counterSuite() {
      const user = this.$store.state.user || {}
      return user.counterSuite === true || Number(user.counterSuite) === 1
    },
    platformOptions() {
      return this.platforms.length ? this.platforms : [{ id: 'whatsapp-green', name: 'WhatsApp绿色版' }]
    },
    availableAccountOptions() {
      return this.availableAccounts.filter(item => item.platform === this.accountForm.platform)
    }
  },
  watch: {
    counterSuite(enabled) {
      if (enabled) this.load()
    }
  },
  mounted() {
    // 商户网页使用公开的站点平台表。不能调用 `/client/platforms`：
    // 那是原生客户端专用接口，网页商户会话会收到 401，随后全局拦截器
    // 会判定“登录已过期”并清掉会话，表现就是点进计数工单后自动退出登录。
    this.getRequest('/site/platforms').then(resp => {
      if (resp && resp.data && Array.isArray(resp.data.rows)) this.platforms = resp.data.rows
    }).catch(() => {})
  },
  activated() {
    if (this.counterSuite) this.load()
  },
  methods: {
    load() {
      this.loading = true
      this.getRequest('/count-tickets', this.filters).then(resp => {
        this.loading = false
        if (resp && resp.status === 200) {
          this.rows = resp.data.rows || []
          this.total = Number(resp.data.total) || 0
        }
      }).catch(() => { this.loading = false })
    },
    search() {
      this.filters.page = 1
      this.load()
    },
    changePage(page) {
      this.filters.page = page
      this.load()
    },
    openDetail(row) {
      this.detailVisible = true
      this.detailLoading = true
      this.ticket = Object.assign({}, row)
      this.fanFilters.page = 1
      this.getRequest(`/count-tickets/${row.id}`).then(resp => {
        if (resp && resp.status === 200) {
          this.ticket = resp.data.ticket
          this.metrics = resp.data.metrics || {}
          this.accounts = resp.data.accounts || []
          this.dedupTicketIds = Array.isArray(resp.data.dedupTicketIds)
            ? resp.data.dedupTicketIds.map(Number)
            : []
          this.loadGroupOptions(this.ticket.platform)
          this.loadFans(1)
        }
      }).finally(() => { this.detailLoading = false })
    },
    loadFans(page) {
      if (!this.ticket) return
      this.fanFilters.page = page || this.fanFilters.page
      const params = Object.assign({}, this.fanFilters, { rows: 20 })
      this.getRequest(`/count-tickets/${this.ticket.id}/fans`, params).then(resp => {
        if (resp && resp.status === 200) {
          this.fans = resp.data.rows || []
          this.fanTotal = Number(resp.data.total) || 0
        }
      }).catch(() => {})
    },
    openTicketForm(row) {
      const source = row || {}
      const totalFans = Number(source.totalFans != null ? source.totalFans : this.metrics.totalFans) || 0
      this.ticketForm = {
        id: source.id || null,
        title: source.title || '',
        platform: source.platform || (this.platforms[0] && this.platforms[0].id) || 'whatsapp-green',
        status: source.status || 'active',
        dayTarget: Number(source.dayTarget) || 0,
        totalTarget: Number(source.totalTarget) || 0,
        timezone: source.timezone || 'Asia/Shanghai',
        zeroTime: source.zeroTime || '00:00:00',
        dedupScope: source.dedupScope || 'merchant',
        groupId: source.groupId == null ? null : Number(source.groupId),
        dedupBaseEnabled: source.dedupBaseEnabled === true,
        linkedTicketIds: Array.isArray(source.dedupTicketIds)
          ? source.dedupTicketIds.map(Number)
          : (source.id && Array.isArray(this.dedupTicketIds) ? this.dedupTicketIds.slice() : []),
        dedupLocked: !!source.id && totalFans > 0
      }
      this.ticketDialog = true
      this.loadDedupOptions(this.ticketForm.platform, this.ticketForm.id)
      this.loadGroupOptions(this.ticketForm.platform)
    },
    loadDedupOptions(platform, ticketId) {
      this.dedupOptions = []
      if (!platform) return
      this.dedupOptionsLoading = true
      this.getRequest('/count-tickets/dedup-options', {
        platform,
        ticketId: ticketId || ''
      }).then(resp => {
        if (resp && resp.data && Array.isArray(resp.data.rows)) {
          this.dedupOptions = resp.data.rows
        }
      }).catch(() => {}).finally(() => {
        this.dedupOptionsLoading = false
      })
    },
    loadGroupOptions(platform) {
      this.groupOptions = []
      if (!platform) return
      this.getRequest('/count-tickets/groups', { platform }).then(resp => {
        if (resp && resp.data && Array.isArray(resp.data.rows)) {
          this.groupOptions = resp.data.rows
        }
      }).catch(() => {})
    },
    openGroupManager() {
      const platform = this.ticketForm.platform || (this.platformOptions[0] && this.platformOptions[0].id) || 'whatsapp-green'
      this.groupForm = { id: null, name: '', platform }
      this.groupDialog = true
      this.loadGroups()
    },
    loadGroups() {
      this.groupsLoading = true
      this.getRequest('/count-tickets/groups', {
        platform: this.groupForm.platform
      }).then(resp => {
        if (resp && resp.data && Array.isArray(resp.data.rows)) {
          this.groups = resp.data.rows
        }
      }).catch(() => {}).finally(() => {
        this.groupsLoading = false
      })
    },
    editGroup(group) {
      this.groupForm = {
        id: Number(group.id),
        name: group.name,
        platform: group.platform
      }
    },
    resetGroupForm() {
      this.groupForm = {
        id: null,
        name: '',
        platform: this.groupForm.platform
      }
    },
    saveGroup() {
      if (!String(this.groupForm.name || '').trim()) {
        this.$message.warning('请填写分组名称')
        return
      }
      this.groupSaving = true
      this.postRequest('/count-tickets/groups/save', this.groupForm).then(resp => {
        if (resp && resp.data && resp.data.success === 'success') {
          this.$message.success(resp.data.msg)
          this.loadGroups()
          this.loadGroupOptions(this.ticketForm.platform)
          this.resetGroupForm()
        }
      }).catch(() => {}).finally(() => {
        this.groupSaving = false
      })
    },
    deleteGroup(group) {
      this.$confirm(`确认删除分组「${group.name}」？分组下仍有工单时不能删除。`, '删除分组', {
        type: 'warning'
      }).then(() => this.postRequest('/count-tickets/groups/delete', {
        id: group.id
      })).then(resp => {
        if (resp && resp.data && resp.data.success === 'success') {
          this.$message.success(resp.data.msg)
          this.loadGroups()
          this.loadGroupOptions(this.ticketForm.platform)
        }
      }).catch(() => {})
    },
    openBaseManager() {
      const platform = this.ticketForm.platform || (this.platformOptions[0] && this.platformOptions[0].id) || 'whatsapp-green'
      this.baseForm = { platform, filename: '', text: '' }
      this.baseFilters = { platform, keyword: '', page: 1, rows: 20 }
      this.baseDialog = true
      this.refreshBase()
    },
    refreshBase() {
      this.baseFilters.platform = this.baseForm.platform
      this.loadBaseStats()
      this.loadBaseEntries(1)
    },
    loadBaseStats() {
      this.getRequest('/count-tickets/base/stats', {
        platform: this.baseForm.platform
      }).then(resp => {
        if (resp && resp.data) this.baseStats = resp.data
      }).catch(() => {})
    },
    loadBaseEntries(page) {
      this.baseFilters.platform = this.baseForm.platform
      this.baseFilters.page = page || this.baseFilters.page
      this.getRequest('/count-tickets/base/entries', this.baseFilters).then(resp => {
        if (resp && resp.data) {
          this.baseEntries = resp.data.rows || []
          this.baseEntryTotal = Number(resp.data.total) || 0
        }
      }).catch(() => {})
    },
    readBaseFile(event) {
      const file = event.target.files && event.target.files[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        this.baseForm.filename = file.name
        this.baseForm.text = String(reader.result || '')
      }
      reader.onerror = () => this.$message.error('文件读取失败')
      reader.readAsText(file, 'utf-8')
      event.target.value = ''
    },
    async importBase() {
      const lines = String(this.baseForm.text || '').split(/\r?\n/).filter(line => line.trim())
      if (!lines.length) {
        this.$message.warning('没有可导入的数据')
        return
      }
      this.baseImporting = true
      let accepted = 0
      let inserted = 0
      let updated = 0
      try {
        for (let i = 0; i < lines.length; i += 250) {
          const chunk = lines.slice(i, i + 250)
          const resp = await this.postRequest('/count-tickets/base/import', {
            platform: this.baseForm.platform,
            filename: this.baseForm.filename,
            text: chunk.join('\n')
          })
          if (!resp || !resp.data || resp.data.success !== 'success') {
            throw new Error('导入失败')
          }
          accepted += Number(resp.data.accepted) || 0
          inserted += Number(resp.data.inserted) || 0
          updated += Number(resp.data.updated) || 0
        }
        this.$message.success(`导入完成：新增 ${inserted}，覆盖 ${updated}，有效 ${accepted}`)
        this.baseForm.text = ''
        this.baseForm.filename = ''
        this.loadBaseStats()
        this.loadBaseEntries(1)
      } catch (_error) {
        this.$message.error('底库导入未全部完成，请检查格式或网络后重试')
      } finally {
        this.baseImporting = false
      }
    },
    clearBase() {
      this.$confirm(
        `确认清空「${platformName(this.baseForm.platform)}」当前应用的底库？历史进粉不会被删除。`,
        '清空底库',
        { type: 'warning' }
      ).then(() => this.postRequest('/count-tickets/base/clear', {
        platform: this.baseForm.platform
      })).then(resp => {
        if (resp && resp.data && resp.data.success === 'success') {
          this.$message.success(resp.data.msg)
          this.baseClearing = false
          this.loadBaseStats()
          this.loadBaseEntries(1)
        }
      }).catch(() => { this.baseClearing = false })
      this.baseClearing = true
    },
    ticketGroupName(groupId) {
      const group = this.groupOptions.find(item => Number(item.id) === Number(groupId))
      return group ? group.name : `分组 #${groupId}`
    },
    handleTicketPlatformChange(platform) {
      this.ticketForm.linkedTicketIds = []
      this.ticketForm.dedupScope = 'merchant'
      this.ticketForm.groupId = null
      this.loadDedupOptions(platform, this.ticketForm.id)
      this.loadGroupOptions(platform)
    },
    handleDedupScopeChange(scope) {
      if (scope !== 'linked') this.ticketForm.linkedTicketIds = []
    },
    dedupScopeLabel(scope) {
      if (scope === 'ticket') return '仅当前工单'
      if (scope === 'group') return '命名分组内'
      if (scope === 'linked') return '指定关联工单'
      return '同商户全部工单'
    },
    dedupScopeDescription(scope) {
      if (scope === 'ticket') {
        return '只和本工单历史进粉比较；同一客户进入其它工单仍算新粉。'
      }
      if (scope === 'group') {
        return '只和当前命名分组内的同应用工单比较，分组外和不同应用都不参与。'
      }
      if (scope === 'linked') {
        return '只和本工单及下方选中工单的历史进粉比较，不能跨应用。'
      }
      return '和本商户同一应用的全部工单比较；不同应用、不同商户互不影响。'
    },
    saveTicket() {
      if (!String(this.ticketForm.title || '').trim()) {
        this.$message.warning('请填写工单名称')
        return
      }
      if (this.ticketForm.dedupScope === 'linked' && !this.ticketForm.linkedTicketIds.length) {
        this.$message.warning('指定查重工单至少需要选择一张其它工单')
        return
      }
      if (this.ticketForm.dedupScope === 'group' && !this.ticketForm.groupId) {
        this.$message.warning('组内查重必须先选择命名分组')
        return
      }
      this.savingTicket = true
      this.postRequest('/count-tickets/save', this.ticketForm).then(resp => {
        this.savingTicket = false
        if (resp && resp.data && resp.data.success === 'success') {
          this.$message.success(resp.data.msg)
          const id = resp.data.id
          this.ticketDialog = false
          this.load()
          if (this.detailVisible && id) {
            this.openDetail({ id })
          }
        }
      }).catch(() => { this.savingTicket = false })
    },
    openAccountForm() {
      this.accountForm = { platform: this.ticket.platform, accountKey: '' }
      this.accountDialog = true
      this.getRequest('/count-tickets/available-accounts', {
        ticketId: this.ticket.id
      }).then(resp => {
        if (resp && resp.data && Array.isArray(resp.data.rows)) {
          this.availableAccounts = resp.data.rows
          if (this.availableAccounts.length) {
            const first = this.availableAccounts[0]
            this.accountForm.accountKey = first.accountKey
          }
        }
      }).catch(() => {})
    },
    saveAccount() {
      if (!String(this.accountForm.accountKey || '').trim()) {
        this.$message.warning('请选择或填写接入账号')
        return
      }
      this.savingAccount = true
      this.postRequest('/count-tickets/accounts/save', Object.assign({
        ticketId: this.ticket.id
      }, this.accountForm)).then(resp => {
        this.savingAccount = false
        if (resp && resp.data && resp.data.success === 'success') {
          this.$message.success(resp.data.msg)
          this.accountDialog = false
          this.openDetail({ id: this.ticket.id })
        }
      }).catch(() => { this.savingAccount = false })
    },
    deactivate(row) {
      this.$confirm(`停用账号 ${row.accountKey} 后，新会话将不再计入本工单。`, '停用计数账号', {
        type: 'warning'
      }).then(() => this.postRequest('/count-tickets/accounts/remove', {
        ticketId: this.ticket.id,
        platform: row.platform,
        accountKey: row.accountKey
      })).then(resp => {
        if (resp && resp.data && resp.data.success === 'success') {
          this.$message.success(resp.data.msg)
          this.openDetail({ id: this.ticket.id })
        }
      }).catch(() => {})
    },
    platformName(id) {
      const found = this.platforms.find(item => item.id === id)
      return found ? found.name : id
    },
    formatTime(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      const p = n => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`
    }
  }
}
</script>

<style scoped>
.count-page {
  --count-ink: #17212b;
  --count-muted: #637083;
  --count-line: #dfe5ec;
  --count-paper: #fbfaf6;
  --count-blue: #0f4c81;
  --count-blue-soft: #e8f1f8;
  --count-amber: #a55612;
  --count-amber-soft: #fff2dd;
  color: var(--count-ink);
  text-align: left;
}
.count-hero {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding: 26px 30px;
  margin-bottom: 14px;
  color: #f8f4ea;
  background:
    linear-gradient(115deg, rgba(255,255,255,.07) 0 1px, transparent 1px 26px),
    linear-gradient(145deg, #152536, #0f4c81);
  border-radius: 16px;
  box-shadow: 0 16px 36px rgba(15, 76, 129, .18);
}
.count-hero h1,
.count-detail h2 {
  margin: 4px 0 7px;
  font-family: "STSong", "Songti SC", serif;
  font-size: 30px;
  letter-spacing: .04em;
}
.count-hero p,
.count-detail-head p {
  margin: 0;
  max-width: 680px;
  color: rgba(255,255,255,.72);
  line-height: 1.7;
}
.count-hero-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.count-kicker {
  color: #eab66e;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .2em;
}
.count-locked {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 30px;
  border: 1px solid #ecd9b7;
  border-radius: 16px;
  background: linear-gradient(135deg, #fffaf1, #f7f1e7);
  box-shadow: 0 12px 30px rgba(94, 69, 30, .08);
}
.count-locked-mark {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 58px;
  height: 58px;
  border-radius: 16px;
  color: #fff;
  background: #a55612;
  font: 700 18px/1 "STSong", "Songti SC", serif;
  letter-spacing: .08em;
}
.count-locked h2 {
  margin: 0 0 7px;
  color: #5f380d;
  font-family: "STSong", "Songti SC", serif;
}
.count-locked p {
  flex: 1;
  margin: 0;
  color: #745d3f;
  line-height: 1.7;
}
.count-empty-onboarding {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 28px;
  border: 1px dashed #b8c8d8;
  border-radius: 14px;
  background: linear-gradient(135deg, #f8fbfd, #f2f6f9);
}
.count-empty-mark {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  border-radius: 16px;
  color: #fff;
  background: var(--count-blue);
  font: 700 17px/1 "STSong", "Songti SC", serif;
}
.count-empty-copy {
  flex: 1;
  min-width: 0;
}
.count-empty-copy h3 {
  margin: 0 0 6px;
  color: var(--count-ink);
  font-family: "STSong", "Songti SC", serif;
  font-size: 20px;
}
.count-empty-copy p {
  margin: 0;
  color: var(--count-muted);
  line-height: 1.65;
}
.count-empty-steps {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin-top: 14px;
  color: var(--count-blue);
  font-size: 12px;
  font-weight: 650;
}
.count-panel,
.count-section {
  background: var(--count-paper);
  border: 1px solid var(--count-line);
  border-radius: 14px;
}
.count-panel { padding: 16px; }
.count-toolbar,
.count-fan-filters,
.count-detail-actions,
.count-section-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.count-toolbar { margin-bottom: 14px; }
.count-toolbar .el-input { width: 260px; }
.count-toolbar .el-select { width: 130px; }
.count-rule {
  margin-left: auto;
  color: var(--count-muted);
  font-size: 12px;
}
.count-title {
  padding: 0;
  border: 0;
  color: var(--count-ink);
  background: transparent;
  font: inherit;
  font-weight: 650;
  text-align: left;
  cursor: pointer;
}
.count-title:hover { color: var(--count-blue); }
.count-title small {
  display: block;
  margin-top: 4px;
  color: var(--count-muted);
  font-weight: 400;
}
.count-number {
  font-variant-numeric: tabular-nums;
  font-size: 16px;
}
.count-repeat { color: var(--count-amber); }
.count-scope {
  display: block;
  margin-top: 3px;
  color: var(--count-muted);
  font-size: 11px;
}
.count-scope-tip {
  margin-top: 5px;
}
.count-base-mark { color: var(--count-blue); font-weight: 650; }
.count-inline-form { display: flex; align-items: flex-start; gap: 6px; flex-wrap: wrap; }
.count-inline-form .el-input { width: 220px; }
.count-base-head,
.count-base-import-head,
.count-base-import-actions,
.count-base-list-head {
  display: flex;
  align-items: center;
  gap: 14px;
}
.count-base-head {
  padding: 14px;
  margin-bottom: 12px;
  border: 1px solid var(--count-line);
  border-radius: 12px;
  background: var(--count-blue-soft);
}
.count-base-head > .count-danger { margin-left: auto; }
.count-base-stat {
  min-width: 120px;
  padding-left: 14px;
  border-left: 1px solid #c9dce9;
}
.count-base-stat span { display: block; color: var(--count-muted); font-size: 11px; }
.count-base-stat b { display: block; margin-top: 4px; font-size: 20px; }
.count-base-time { font-size: 13px !important; }
.count-base-import,
.count-base-list {
  padding: 14px;
  margin-top: 12px;
  border: 1px solid var(--count-line);
  border-radius: 12px;
  background: #fff;
}
.count-base-import-head { justify-content: space-between; margin-bottom: 10px; }
.count-base-import-head h3,
.count-base-list h3 { margin: 0 0 4px; }
.count-base-import-head p { margin: 0; color: var(--count-muted); font-size: 12px; }
.count-base-import-actions { justify-content: flex-end; margin-top: 10px; }
.count-base-import-actions span { margin-right: auto; color: var(--count-muted); font-size: 12px; }
.count-base-list-head { margin-bottom: 10px; }
.count-base-list-head h3 { margin-right: auto; }
.count-base-list-head .el-input { width: 240px; }
.count-file-input { display: none; }
.count-pagination { margin-top: 14px; text-align: right; }
.count-detail { padding: 22px; }
.count-detail-head {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: flex-start;
  padding: 22px 24px;
  color: #f8f4ea;
  background: linear-gradient(135deg, #152536, #234f70);
  border-radius: 14px;
}
.count-detail-head h2 { font-size: 28px; }
.count-metrics {
  display: grid;
  grid-template-columns: repeat(6, minmax(120px, 1fr));
  gap: 10px;
  margin: 14px 0;
}
.metric-card {
  padding: 16px;
  background: var(--count-paper);
  border: 1px solid var(--count-line);
  border-left: 4px solid #9aa9b9;
  border-radius: 12px;
}
.metric-card span {
  display: block;
  color: var(--count-muted);
  font-size: 12px;
}
.metric-card b {
  display: block;
  margin-top: 8px;
  font: 700 26px/1.1 "Avenir Next Condensed", "DIN Alternate", sans-serif;
  font-variant-numeric: tabular-nums;
}
.metric-primary { border-left-color: var(--count-blue); background: var(--count-blue-soft); }
.metric-repeat { border-left-color: var(--count-amber); background: var(--count-amber-soft); }
.count-section { padding: 18px; margin-top: 14px; }
.count-section-head { justify-content: space-between; margin-bottom: 12px; }
.count-section-head h3 { margin: 0 0 4px; font-size: 17px; }
.count-section-head p { margin: 0; color: var(--count-muted); font-size: 12px; }
.count-fan-filters .el-input { width: 180px; }
.count-fan-filters .el-select { width: 96px; }
.count-danger { color: #b42318; }
.count-form-tip {
  margin: 0;
  color: var(--count-muted);
  font-size: 12px;
  line-height: 1.7;
}
@media (max-width: 1100px) {
  .count-metrics { grid-template-columns: repeat(3, minmax(120px, 1fr)); }
  .count-rule { display: none; }
}
@media (max-width: 720px) {
  .count-hero,
  .count-detail-head,
  .count-section-head { align-items: stretch; flex-direction: column; }
  .count-metrics { grid-template-columns: repeat(2, minmax(110px, 1fr)); }
  .count-toolbar,
  .count-fan-filters { flex-wrap: wrap; }
}
@media (prefers-reduced-motion: reduce) {
  .count-page * { transition: none !important; animation: none !important; }
}
</style>
