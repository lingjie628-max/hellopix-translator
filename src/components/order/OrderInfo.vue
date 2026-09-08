<template>
  <div>
    <el-container>
      <el-header style="text-align: left;height: auto; padding: 0;">
        <div>
          <div id="pcSearch">
            工单号：
            <el-input placeholder="请输入工单号" clearable v-model="searchOrderNum"
                      style="width: 200px;margin: 0px;padding: 0px;"></el-input>
            <span id="pcDataSearch">
            主号：
            <el-input placeholder="请输入主号" clearable v-model="searchNickName"
                      style="width: 200px;margin: 0px;padding: 0px;"></el-input>
            工单名称：
            <el-input placeholder="请输入工单名称" clearable v-model="searchTitle"
                       style="width: 200px;margin: 0px;padding: 0px;"></el-input>
            工单状态：
            <el-select v-model="searchStatus" placeholder="请选择" style="width:80px">
              <el-option label="全部" value="">全部</el-option>
              <el-option label="正常" value="1">正常</el-option>
              <el-option label="关闭" value="2">关闭</el-option>
              <el-option label="过期" value="3">过期</el-option>
            </el-select>
            工单到期时间：
            <el-date-picker v-model="value" type="datetimerange" start-placeholder="开始日期" end-placeholder="结束日期"
                            :default-time="['00:00:00', '23:59:59']" value-format="yyyy-MM-dd HH:mm:ss"
                            format="yyyy-MM-dd HH:mm:ss"></el-date-picker>
            </span>
            <el-button type="primary" style="margin-left: 0px;margin-top: 10px;width: 118px" icon="el-icon-search" @click="searchOrder"> 搜   索 </el-button>
          </div>
          <div id="phoneSearch" style="display: none">
            <el-select v-model="selectType" clearable placeholder="请选择" style="width: 100px">
              <el-option
                v-for="item in options"
                :key="item.value"
                :label="item.label"
                :value="item.value">
              </el-option>
            </el-select>
            <el-input  clearable v-model="phoneSearch" style="width: 170px;margin: 0px;padding: 0px;"></el-input>
            <el-button type="primary" style="margin-left: 0px;margin-top: 10px;width: 118px" icon="el-icon-search" @click="searchPhoneOrder"> 搜   索 </el-button>
            <el-dropdown id="phoneBtn" style="display: none;margin-top: 10px;float: right" @command="handleCommand" trigger="click">
              <el-button type="danger">
                批量操作<i class="el-icon-arrow-down el-icon--right"></i>
              </el-button>
              <el-dropdown-menu slot="dropdown" :append-to-body="false" class="popper-dropdown">
                <el-dropdown-item command="a" :disabled="orderTimeBtnFlag">工单续时</el-dropdown-item>
                <el-dropdown-item command="b" :disabled="orderTimeBtnFlag">分配设置</el-dropdown-item>
                <el-dropdown-item command="c" :disabled="orderCloseFlag">关闭工单</el-dropdown-item>
                <el-dropdown-item command="d" :disabled="orderCloseFlag">开启工单</el-dropdown-item>
                <el-dropdown-item command="e" :disabled="orderCloseFlag">删除工单</el-dropdown-item>
                <el-dropdown-item command="f" :disabled="orderCloseFlag">修改分享密码</el-dropdown-item>
                <el-dropdown-item command="g" :disabled="orderCloseFlag">取消分享</el-dropdown-item>
                <el-dropdown-item command="h" :disabled="orderCloseFlag">释放离线账号</el-dropdown-item>
                <el-dropdown-item command="i" :disabled="orderCloseFlag">重置工单</el-dropdown-item>
              </el-dropdown-menu>
            </el-dropdown>
          </div>
        </div>
        <div style="margin-top:10px;">
          <el-button type="primary" icon="el-icon-plus" @click="showAddEmpView">创建工单</el-button>
          <el-button type="success" @click="exportOrder" icon="el-icon-s-promotion" :disabled="orderTimeBtnFlag" id="exportBtn">导出数据</el-button>
          <span id="pcBtn" style="margin-left: 10px;">
            <el-button type="warning" plain :disabled="orderTimeBtnFlag" icon="el-icon-alarm-clock" @click="showOrderExpTime">工单续时</el-button>
            <el-button type="danger" icon="el-icon-s-claim" @click="showOrderModeView" :disabled="orderTimeBtnFlag">分配设置</el-button>
            <el-button type="info" icon="el-icon-circle-close" @click="orderClose(2)" :disabled="orderCloseFlag">关闭工单</el-button>
            <el-button type="success" icon="el-icon-folder-opened" @click="orderClose(1)" :disabled="orderCloseFlag">开启工单</el-button>
            <el-button type="warning" icon="el-icon-delete" @click="deleteOrder()" :disabled="orderCloseFlag">删除工单</el-button>
            <el-button type="primary" icon="el-icon-edit" @click="showSharePwd()" :disabled="orderCloseFlag">修改分享密码</el-button>
            <el-button type="danger" icon="el-icon-document-delete" @click="cancelSharePwd()" :disabled="orderCloseFlag">取消分享</el-button>
            <el-button type="warning" icon="el-icon-delete" @click="cancelAccount()" :disabled="orderCloseFlag">释放离线账号</el-button>
            <el-button type="danger" icon="el-icon-refresh-left" @click="resetOrder()" :disabled="orderCloseFlag">重置工单</el-button>
          </span>
        </div>
        <div style="margin-top: 10px;">
          <span
            style="font-size: 14px;color:#209cdf">聊天号不限登录<span
            style="color:#6c757d;margin-left:20px">子账号里 Telegram / WhatsApp 等可无限登录。同一账号同时只能一台电脑在线，新电脑登录会踢下旧电脑。</span></span>
        </div>
      </el-header>

      <el-main style="padding-left: 0px;padding-top: 10px">
        <div>
          <el-table :data="orders" v-loading="tableLoading"  @selection-change="handleSelectionChange">
            <el-table-column type="selection" align="center" fixed="left" width="30"></el-table-column>
            <el-table-column prop="serialNumber"  align="center" label="工单号" width="170px">
              <template slot-scope="scope">
                {{ scope.row.serialNumber }}<i class="el-icon-document-copy" style="margin-left:10px;cursor:pointer"
                                               @click="copyOrderNum(scope.row.serialNumber)"></i>
              </template>
            </el-table-column>
            <el-table-column prop="title" align="center" label="工单名称" width="180px"></el-table-column>
            <el-table-column prop="type" align="center"  label="工单类型" width="100px"
                             :filters="[{ text: 'whatsApp', value: 'whatsApp' }, { text: 'Line', value: 'Line' }, { text: 'Zalo', value: 'Zalo' }, { text: 'telegram_z', value: 'telegram_z' }, { text: 'messenger', value: 'messenger' }]"
                             :filter-method="filterTypeHandler"></el-table-column>
            <el-table-column prop="usePorts,port" align="center"  label="已使用/端口数" width="120px">
              <template slot-scope="scope"> {{ scope.row.usePorts }}/{{ scope.row.port }}</template>
            </el-table-column>
            <el-table-column prop="onlineTotal,totalUser" align="center"  label="在线账户/账号总数" width="150px">
              <template slot-scope="scope"> {{ scope.row.onlineTotal }}/{{ scope.row.totalUser }}</template>
            </el-table-column>
            <el-table-column prop="completeTarget,totalTarget" align="center"  label="已完成/总目标" width="120px">
              <template slot-scope="scope"> {{ scope.row.completeTarget }}/{{ scope.row.totalTarget }}</template>
            </el-table-column>
            <el-table-column prop="dayTarget" align="center"  label="单日目标" width="80px"></el-table-column>
            <el-table-column prop="sharePassword" align="center"  label="分享密码" width="80px"></el-table-column>
            <el-table-column prop="createTime,expirationTime" align="center"  label="发布时间/到期时间" width="180px">
              <template slot-scope="scope">
                <el-link type="success" :underline="false">{{ scope.row.createTime | formatDateTime }}</el-link>
                <el-link type="danger" :underline="false">{{ scope.row.expirationTime| formatDateTime }}</el-link>
              </template>
            </el-table-column>
            <el-table-column prop="passwordExpirationTime" align="center"  label="链接失效时间" width="180px">
              <template slot-scope="scope">
                <el-link type="success" :underline="false">{{ scope.row.passwordExpirationTime | formatDateTime }}
                </el-link>
              </template>
            </el-table-column>
            <el-table-column prop="distributionMode" align="center"  label="分配方式"
                             :formatter="formateDistributionMode" width="90px"
                             :filters="[{ text: '在线账号', value: 1 }, { text: '全站分配', value: 2 }]"
                             :filter-method="filterDistributionModeHandler"></el-table-column>
            <el-table-column prop="status" align="center"  label="工单状态" :formatter="formateStatus" width="90px"
                             :filters="[{ text: '正常', value: 1 }, { text: '关闭', value: 2 }, { text: '过期', value: 3 }]"
                             :filter-method="filterStatusHandler"></el-table-column>
            <el-table-column prop="zeroTime" align="center"  label="置零时间" width="80px"></el-table-column>
            <el-table-column label="备注" align="center" prop="remarks" width="300px">
              <template slot-scope="scope">
					<span v-if="showRemarks">
						<el-input ref="remarks" v-model="scope.row.remarks" style="width: 70%"></el-input>
						<el-button type="success" icon="el-icon-check" circle @click="updateRemaks(scope.row.id, scope.row.remarks)"
                       title="保存"></el-button>
					</span>
                <span v-else>{{ scope.row.remarks }}
						<el-button type="primary" style="float:right" icon="el-icon-edit" circle @click="enableBtn()" title="备注修改"
                       plain></el-button>

					</span>
              </template>
            </el-table-column>

            <el-table-column label="操作" align="center" fixed="right" width="240px" id="pcColumn" v-if="pcColumn">
              <template slot-scope="scope">
                <el-button @click="showOrder(scope.row)" type="primary" icon="el-icon-message" circle
                           title="工单明细"></el-button>
                <el-button @click="setSharePwd(scope.row)" type="primary" icon="el-icon-share" circle title="分享工单"
                           plain></el-button>
                <el-button @click="orderTalk(scope.row)" type="primary" icon="el-icon-menu" circle title="话术设置"
                           plain></el-button>
                <el-button @click="showEditOrder(scope.row)" type="primary" icon="el-icon-edit" circle title="编辑工单"
                           plain></el-button>
              </template>
            </el-table-column>

            <el-table-column label="操作" align="center" fixed="right" id="phoneColumn" width="80px" v-if="phoneColumn">
              <template slot-scope="scope">
                <table>
                  <tr>
                    <td><el-button @click="showOrder(scope.row)" type="primary" icon="el-icon-message" circle title="工单明细" size="mini"></el-button></td>
                    <td><el-button @click="setSharePwd(scope.row)" type="primary" icon="el-icon-share" circle title="分享工单" plain size="mini"></el-button></td>
                  </tr>
                  <tr>
                    <td><el-button @click="orderTalk(scope.row)" type="primary" icon="el-icon-menu" circle title="话术设置" plain size="mini"></el-button></td>
                    <td><el-button @click="showEditOrder(scope.row)" type="primary" icon="el-icon-edit" circle title="编辑工单" plain size="mini"></el-button></td>
                  </tr>
                </table>
              </template>
            </el-table-column>
          </el-table>
          <div style="display: flex;justify-content: space-between;margin: 2px">
            <div class="block">
              <el-pagination @size-change="handleSizeChange" @current-change="currentChange" :current-page="currentPage" v-if="pcColumn"
                             :page-sizes="[10, 20, 50, 100]" :page-size="rows"
                             layout="total, sizes, prev, pager, next, jumper"
                             :total="totalCount">
              </el-pagination>

              <el-pagination @size-change="handleSizeChange" @current-change="currentChange" :current-page="currentPage" v-if="phoneColumn"
                             :page-sizes="[10, 20, 50, 100]" :page-size="rows"
                             layout="total, sizes, prev, pager, next"
                             :total="totalCount">
              </el-pagination>
            </div>
          </div>
        </div>
      </el-main>
    </el-container>

    <el-form :model="order" :rules="rules" ref="addOrderForm" style="margin: 0px;padding: 0px;">
      <div style="text-align: left">
        <el-dialog :title="dialogTitle" style="padding: 0px;" :close-on-click-modal="false"
                   :visible.sync="dialogVisible" width="400px">
          <el-row>
            <el-col>
              <div>
                <el-form-item label="工单名称" prop="title">
                  <el-input type="text" placeholder="请输入工单名称" v-model="order.title" maxlength="20" show-word-limit
                            style="width:250px"/>
                </el-form-item>
              </div>
            </el-col>
          </el-row>
          <el-row>
            <el-col>
              <div>
                <el-form-item label="工单类型" prop="type">
                  <el-select style="width: 250px" v-model="order.type" placeholder="工单类型" >
                    <el-option value="whatsApp">whatsApp</el-option>
                    <el-option value="Line">Line</el-option>
                    <el-option value="Zalo">Zalo</el-option>
                    <el-option value="telegram_z">telegram_z</el-option>
                    <el-option value="messenger">messenger</el-option>
                  </el-select>
                </el-form-item>
              </div>
            </el-col>
          </el-row>
          <el-row>
            <el-col>
              <div>
                <el-form-item label=" 端 口 数 " prop="port">
                  <el-input-number v-model="order.port" :min="1" style="width:250px"></el-input-number>
                </el-form-item>
              </div>
            </el-col>
          </el-row>
          <el-row>
            <el-col>
              <div>
                <el-form-item label="到期时间" prop="expirationTime">
                  <el-date-picker v-model="order.expirationTime" type="datetime" placeholder="选择到期时间"
                                  value-format="yyyy-MM-dd HH:mm:ss" style="width:250px"></el-date-picker>
                </el-form-item>
              </div>
            </el-col>
          </el-row>
          <el-row>
            <el-col>
              <div>
                <el-form-item label="单日目标" prop="dayTarget">
                  <el-input-number v-model="order.dayTarget" :min="1" style="width:250px"></el-input-number>
                </el-form-item>
              </div>
            </el-col>
          </el-row>
          <el-row>
            <el-col>
              <div>
                <el-form-item label=" 总 目 标 " prop="totalTarget">
                  <el-input-number v-model="order.totalTarget" :min="1" style="width:250px"></el-input-number>
                </el-form-item>
              </div>
            </el-col>
          </el-row>
          <el-row>
            <el-col>
              <div>
                <el-form-item label="置零时间" prop="zeroTime">
                  <el-time-select v-model="order.zeroTime"
                                  :picker-options="{start: '00:00', step: '00:15', end: '23:45'}"
                                  placeholder="选择时间" style="width:250px"></el-time-select>
                </el-form-item>
              </div>
            </el-col>
          </el-row>
          <el-row>
            <el-col>
              <div>
                <el-form-item label="聊天助手">
                  <el-select v-model="order.assistant" style="width: 260px" multiple>
                    <el-option
                      v-for="item in assistantGroup"
                      :key="item.id"
                      :label="item.title"
                      :value="item.id">
                    </el-option>
                  </el-select>
                </el-form-item>
              </div>
            </el-col>
          </el-row>
          <el-row>
            <el-col>
              <div>
                <el-form-item label="工单备注">
                  <el-input type="textarea" placeholder="请输入工单备注" v-model="order.remarks" maxlength="50" show-word-limit
                            style="width:260px">
                  </el-input>
                </el-form-item>
              </div>
            </el-col>
          </el-row>
          <span slot="footer" class="dialog-footer">
				<el-button @click="cancelEidt">取 消</el-button>
				<el-button type="primary" @click="addOrder('addOrderForm')">确 定</el-button>
			</span>
        </el-dialog>
      </div>
    </el-form>

    <el-form ref="orderTimeForm" style="margin: 0px;padding: 0px;">
      <div style="text-align: left">
        <el-dialog title="工单续时" style="padding: 0px;" :close-on-click-modal="false"
                   :visible.sync="orderTimeDialogVisible" width="320px">
          <el-row>
            <el-col>
              <div>
                <el-form-item label="工单号:">
                  <div>{{ orderNums }}</div>
                </el-form-item>
              </div>
            </el-col>
          </el-row>
          <el-row>
            <el-col>
              <div>
                <el-form-item label="续时天数:">
                  <el-input-number v-model="orderDays" :min="1" style="width: 160px"></el-input-number>
                  天
                </el-form-item>
              </div>
            </el-col>
          </el-row>
          <span slot="footer" class="dialog-footer">
				<el-button @click="cancelOrderTimeEidt">取 消</el-button>
				<el-button type="primary" @click="saveOrderExpTime()">确 定</el-button>
			</span>
        </el-dialog>
      </div>
    </el-form>

    <el-form ref="orderTalkForm" style="margin: 0px;padding: 0px;">
      <div style="text-align: left">
        <el-dialog title="话术设置" style="padding: 0px;" :close-on-click-modal="false"
                   :visible.sync="orderTalkFormDialogVisible" width="520px">
          <el-row>
            <el-col>
              <div>
                <el-form-item label="聊天助手">
                  <el-select v-model="selectAssistantGroup" style="width: 200px" multiple @change="selectTalk">
                    <el-option
                      v-for="item in assistantGroup"
                      :key="item.id"
                      :label="item.title"
                      :value="item.id">
                    </el-option>
                  </el-select>
                </el-form-item>
              </div>
            </el-col>
          </el-row>
          <span slot="footer" class="dialog-footer">
				<el-button @click="cancelOrderTalkEidt">取 消</el-button>
				<el-button type="primary" @click="saveOrderTalk()">确 定</el-button>
			</span>
        </el-dialog>
      </div>
    </el-form>

    <el-form ref="orderModeForm" style="margin: 0px;padding: 0px;">
      <div style="text-align: left">
        <el-dialog title="分配设置" style="padding: 0px;" :close-on-click-modal="false"
                   :visible.sync="orderModeDialogVisible" width="320px">
          <el-row>
            <el-col>
              <div>
                <el-form-item label="工单号:">
                  <div>{{ orderNums }}</div>
                </el-form-item>
              </div>
            </el-col>
          </el-row>
          <el-row>
            <el-col>
              <div>
                <el-form-item label="分配方式:">
                  <el-radio v-model="distributionModeValue" label="1">在线账号</el-radio>
                  <el-radio v-model="distributionModeValue" label="2">全站分配</el-radio>
                </el-form-item>
              </div>
            </el-col>
          </el-row>
          <span slot="footer" class="dialog-footer">
				<el-button @click="cancelOrderModeEidt">取 消</el-button>
				<el-button type="primary" @click="saveOrderDistributionMode()">确 定</el-button>
			</span>
        </el-dialog>
      </div>
    </el-form>

    <el-form ref="editOrderModeForm" style="margin: 0px;padding: 0px;">
      <div style="text-align: left">
        <el-dialog title="编辑工单" style="padding: 0px;" :close-on-click-modal="false"
                   :visible.sync="editOrderModeDialogVisible" width="380px">
          <el-row>
            <el-col>
              <div>
                <el-form-item label="工 单 号 : ">
                  <div>{{ showOrderNums }}</div>
                </el-form-item>
              </div>
            </el-col>
          </el-row>
          <el-row>
            <el-col>
              <div>
                <el-form-item label="工单名称:">
                  <el-input type="text" placeholder="请输入工单名称" v-model="order.title" maxlength="20" show-word-limit
                            style="width:250px"/>
                </el-form-item>
              </div>
            </el-col>
          </el-row>
          <el-row>
            <el-col>
              <div>
                <el-form-item label="端 口 数 : ">
                  <el-input-number v-model="order.port" :min="1" style="width:250px"></el-input-number>
                </el-form-item>
              </div>
            </el-col>
          </el-row>

          <span slot="footer" class="dialog-footer">
				<el-button @click="cancelEditOrderModeEidt">取 消</el-button>
				<el-button type="primary" @click="editOrderMode()">确 定</el-button>
			</span>
        </el-dialog>
      </div>
    </el-form>


    <el-form ref="sharePwdForm" style="margin: 0px;padding: 0px;" :rules="rules">
      <div style="text-align: left">
        <el-dialog title="分享工单" style="padding: 0px;" :close-on-click-modal="false"
                   :visible.sync="sharePwdFormDialogVisible" width="520px">
          <el-row>
            <el-col>
              <div>
                <el-form-item label="有效天数:">
                  <el-radio v-model="radio" label="1" @change="setHour">1天</el-radio>
                  <el-radio v-model="radio" label="3" @change="setHour">3天</el-radio>
                  <el-radio v-model="radio" label="7" @change="setHour">7天</el-radio>
                  <el-radio v-model="radio" label="30" @change="setHour">30天</el-radio>
                </el-form-item>
              </div>
            </el-col>
          </el-row>

          <el-row>
            <el-col>
              <div>
                <el-form-item label="有效小时: ">
                  <el-input-number v-model="hours" :min="1" @change="handleChange"></el-input-number>
                </el-form-item>
              </div>
            </el-col>
          </el-row>
          <el-row>
            <el-col>
              <div>
                <el-form-item label="分享密码: ">
                  <el-input type="text" placeholder="请输入分享密码" oninput="value=value.replace(/[^0-9,a-z,A-Z]/g, '')"
                            v-model="order.sharePassword" style="width:300px" maxlength="10" show-word-limit></el-input>
                </el-form-item>
              </div>
            </el-col>
          </el-row>
          <span slot="footer" class="dialog-footer">
				<el-button @click="cancelSharePwdModeEidt">取 消</el-button>
				<el-button type="primary" @click="editSharePwd()">确 定</el-button>
			</span>
        </el-dialog>
      </div>
    </el-form>

    <el-form ref="sharePwdForm" style="margin: 0px;padding: 0px;">
      <div style="text-align: left">
        <el-dialog title="修改分享密码" style="padding: 0px;" :close-on-click-modal="false"
                   :visible.sync="shareEditPwdFormDialogVisible" width="420px">
          <el-row>
            <el-col>
              <div>
                <el-form-item label="分享密码: ">
                  <el-input type="text" placeholder="请输入分享密码" oninput="value=value.replace(/[^0-9,a-z,A-Z]/g, '')"
                            v-model="order.sharePassword" style="width:250px" maxlength="10" show-word-limit></el-input>
                </el-form-item>
              </div>
            </el-col>
          </el-row>
          <span slot="footer" class="dialog-footer">
				<el-button @click="cancelEditSharePwdModeEidt">取 消</el-button>
				<el-button type="primary" @click="updateSharePwd()">确 定</el-button>
			</span>
        </el-dialog>
      </div>
    </el-form>
  </div>
</template>
<script>
export default {
  data() {
    return {
      orders: [],
      value: '',
      selectType: 'searchOrderNum',
      options: [{
        value: 'searchOrderNum',
        label: '工单号'
      },{
        value: 'searchNickName',
        label: '主号'
      },{
        value: 'searchTitle',
        label: '工单名称'
      }],
      phoneSearch: '',
      searchOrderNum: '',
      searchStatus: '',
      searchNickName: '',
      searchTitle:'',
      totalCount: -1,
      currentPage: 1,
      rows: 10,
      hours: '24',
      radio: '1',
      copyVal: '',
      pcColumn: true,
      phoneColumn: false,
      showRemarks: false,
      orderTimeBtnFlag: true,
      tableLoading: false,
      dialogTitle: '',
      orderCloseFlag: true,
      dialogVisible: false,
      orderTimeDialogVisible: false,
      orderModeDialogVisible: false,
      editOrderModeDialogVisible: false,
      orderTalkFormDialogVisible: false,
      sharePwdFormDialogVisible: false,
      shareEditPwdFormDialogVisible: false,
      assistantGroup: [],
      selectAssistantGroup: [],
      orderNums: '',
      orderDays: 1,
      distributionModeValue: '2',
      userPort: 0,
      userUsePort: 0,
      orderTalkId: '',
      orderId: '',
      updateOrderId: '',
      showOrderNums: '',
      order: {
        id: '',
        title: '',
        serialNumber: '',
        type: '',
        usePorts: '',
        port: 1,
        onlineTotal: '',
        totalUser: '',
        completeTarget: '',
        totalTarget: 0,
        dayTarget: 0,
        expirationTime: '',
        createTime: '',
        distributionMode: '',
        status: '',
        remarks: '',
        assistant: '',
        zeroTime: '',
        sharePassword: '',
        passwordExpirationTime: '',
      },
      rules: {
        title: [{required: true, message: '请输入工单名称', trigger: 'blur'}],
        type: [{required: true, message: '请选择工单类型', trigger: 'blur'}],
        port: [{required: true, message: '请输入端口数', trigger: 'blur'}],
        expirationTime: [{required: true, message: '请输入到期时间', trigger: 'blur'}],
        dayTarget: [{required: true, message: '请输入单日目标', trigger: 'blur'}],
        totalTarget: [{required: true, message: '请输入总目标', trigger: 'blur'}],
        zeroTime: [{required: true, message: '请选择置零时间', trigger: 'blur'}],
      },
    };
  },
  mounted: function () {
    this.initData();
    this.loadOrder();
    this.isPc();
  },
  methods: {
    handleCommand(command) {
      if(command === 'a'){
        this.showOrderExpTime();
      }else if(command === 'b'){
        this.showOrderModeView();
      }else if(command === 'c'){
        this.orderClose(2);
      }else if(command === 'd'){
        this.orderClose(1);
      }else if(command === 'e'){
        this.deleteOrder();
      }else if(command === 'f'){
        this.showSharePwd();
      }else if(command === 'g'){
        this.cancelSharePwd();
      }else if(command === 'h'){
        this.cancelAccount();
      }else if(command === 'i'){
        this.resetOrder();
      }
    },
    isPc(){
        let userAgentInfo = navigator.userAgent;
        let Agents = new Array("Android", "iPhone", "SymbianOS", "Windows Phone", "iPad", "iPod");
        let flag = true;
        for (let v = 0; v < Agents.length; v++) {
          if (userAgentInfo.indexOf(Agents[v]) > 0) { flag = false; break; }
        }

        if(!flag){
          this.phoneColumn = true;
          this.pcColumn = false;
        }else{
          this.phoneColumn = false;
          this.pcColumn = true;
        }

        return flag;
    },
    searchPhoneOrder(){
      if(this.selectType === "searchOrderNum"){
        this.searchOrderNum = this.phoneSearch;
        this.searchNickName = "";
        this.searchTitle = "";
      }else if(this.selectType === "searchNickName"){
        this.searchNickName = this.phoneSearch;
        this.searchOrderNum = "";
        this.searchTitle = "";
      }else if(this.selectType === "searchTitle"){
        this.searchTitle = this.phoneSearch;
        this.searchOrderNum = "";
        this.searchNickName = "";
      }
      this.tableLoading = true;
      this.postRequest("/order/getOrder", {
        "page": this.currentPage,
        "rows": this.rows,
        "serialNumber": this.searchOrderNum,
        "status": this.searchStatus,
        "nickName": this.searchNickName,
        "title": this.searchTitle
      }).then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          let data = resp.data;
          this.orders = data.rows;
          this.totalCount = data.total;
        }
      })
    },
    showSharePwd() {
      this.shareEditPwdFormDialogVisible = true;
    },
    selectTalk(value) {
      this.selectAssistantGroup = value;
    },
    filterTypeHandler(value, row) {
      return row.type === value;
    },
    filterDistributionModeHandler(value, row) {
      return row.distributionMode === value;
    },
    filterStatusHandler(value, row) {
      return row.status === value;
    },
    cancelAccount() {
      this.$confirm('确定释放[' + this.orderNums + ']工单下面的离线账号吗? \n释放后工单下面的空账号将会删除，且占用端口的离线账号变成已释放', '提示', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }).then(() => {
        this.postRequest("/order/cancelAccount", {orderNums: this.orderNums}).then(resp => {
          this.tableLoading = false;
          if (resp && resp.status == 200) {
            let data = resp.data;
            this.$message({type: data.success, message: data.msg});
            this.loadOrder();
          }
        })
      }).catch(() => {

      });
    },
    copyOrderNum(value) {
      var input = document.createElement("input"); // 直接构建input
      input.value = value; // 设置内容
      document.body.appendChild(input); // 添加临时实例
      input.select(); // 选择实例内容
      document.execCommand("Copy"); // 执行复制
      document.body.removeChild(input); // 删除临时实例
      this.$message({
        type: 'info',
        message: `复制成功`
      });
    },
    setHour(value) {
      this.radio = value;
      this.hours = value * 24;
    },
    resetOrder() {
      this.$confirm('确认重置[' + this.orderNums + ']工单数据吗？重置后工单下面的所有进粉数据全部清零，请慎重操作!', '提示', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }).then(() => {
        this.postRequest("/order/resetOrder", {orderNums: this.orderNums}).then(resp => {
          this.tableLoading = false;
          if (resp && resp.status == 200) {
            let data = resp.data;
            this.$message({type: data.success, message: data.msg});
            this.loadOrder();
          }
        })
      }).catch(() => {

      });
    },
    saveOrderTalk() {
      this.postRequest("/order/editOrder?orderOperates=edit", {
        id: this.orderTalkId,
        assistant: this.selectAssistantGroup
      }).then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          let data = resp.data;
          this.$message({type: data.success, message: data.msg});
          this.loadOrder();
          this.orderTalkFormDialogVisible = false;
          this.selectAssistantGroup = [];
        }
      })
    },
    editOrderMode() {
      this.postRequest("/order/editOrder?orderOperates=edit", {
        id: this.orderId,
        title: this.order.title,
        port: this.order.port
      }).then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          let data = resp.data;
          this.$message({type: data.success, message: data.msg});
          this.loadOrder();
          this.editOrderModeDialogVisible = false;
        }
      })
    },
    deleteOrder() {
      this.$confirm('确认刪除此[' + this.orderNums + ']工单数据，删除后不可恢复并且不能根据此工单号登录扫码端，请慎重操作!', '提示', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }).then(() => {
        this.postRequest("/order/deleteOrder", {orderIds: this.orderId}).then(resp => {
          this.tableLoading = false;
          if (resp && resp.status == 200) {
            let data = resp.data;
            this.$message({type: data.success, message: data.msg});
            this.loadOrder();
            this.getUserVersion();
          }
        })
      }).catch(() => {

      });
    },
    orderTalk(order) {
      this.orderTalkFormDialogVisible = true;
      this.orderTalkId = order.id;
      let dataIntArr = [];//保存转换后的整型字符串
      if (order.assistant != "") {
        let dataStrArr = order.assistant.split(",");
        dataStrArr.forEach(item => {
          dataIntArr.push(+item);
        });
      }

      this.selectAssistantGroup = dataIntArr;
    },
    enableBtn() {
      this.showRemarks = true;
    },
    updateRemaks(id, remarks) {
      this.postRequest("/order/editOrder?orderOperates=edit", {id: id, remarks: remarks}).then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          let data = resp.data;
          this.$message({type: data.success, message: data.msg});
          this.loadOrder();
          this.showRemarks = false;
        }
      })
    },
    orderClose(value) {
      if (value == 2) {
        this.$confirm('是否关闭该工单[' + this.orderNums + '], 确认后此工单将失去统计进粉功能，请慎重操作!', '提示', {
          confirmButtonText: '确定',
          cancelButtonText: '取消',
          type: 'warning'
        }).then(() => {
          this.closeOrOpenOrder(value);
        }).catch(() => {

        });
      } else {
        this.closeOrOpenOrder(value);
      }
    },
    closeOrOpenOrder(value) {
      this.postRequest("/order/orderCloseOrOpen", {orderNums: this.orderNums, type: value}).then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          var data = resp.data;
          this.$message({type: data.success, message: data.msg});
          this.loadOrder();
        }
      })
    },
    showOrderModeView() {
      this.orderModeDialogVisible = true;
    },
    showOrderExpTime() {
      this.orderTimeDialogVisible = true;
    },
    showEditOrder(row) {
      this.order.title = row.title;
      this.order.port = row.port;
      this.showOrderNums = row.serialNumber;
      this.orderId = row.id;
      this.order.zeroTime = row.zeroTime;
      this.editOrderModeDialogVisible = true;
    },
    saveOrderExpTime() {
      this.postRequest("/order/setOrderExpTime", {orderNums: this.orderNums, orderDays: this.orderDays}).then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          var data = resp.data;
          this.$message({type: data.success, message: data.msg});
          this.orderTimeDialogVisible = false;
          this.loadOrder();
        }
      })
    },
    saveOrderDistributionMode() {
      this.postRequest("/order/setDistributionMode", {
        orderNums: this.orderNums,
        distributionMode: this.distributionModeValue
      }).then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          var data = resp.data;
          this.$message({type: data.success, message: data.msg});
          this.orderModeDialogVisible = false;
          this.loadOrder();
        }
      })
    },
    initData() {
      this.getAssistantGroup();
      this.getUserVersion();
    },
    getAssistantGroup() {
      this.getRequest("/order/getAssistantGroupByUserId").then(resp => {
        if (resp && resp.status == 200) {
          var data = resp.data;
          this.assistantGroup = data;
        }
      })
    },
    getUserVersion() {
      this.getRequest("/userVersion/getUserVersion").then(resp => {
        if (resp && resp.status == 200) {
          var data = resp.data;
          this.userPort = data.port;
          this.userUsePort = data.userPorts;
        }
      })
    },
    cancelSharePwd() {
      this.$confirm('确认后此工单所有分享链接都将失效。', '提示', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }).then(() => {
        this.tableLoading = true;
        this.postRequest("/order/cancelShare", {"orderIds": this.orderId}).then(resp => {
          this.tableLoading = false;
          if (resp && resp.status == 200) {
            this.$message({
              type: 'success',
              message: resp.data.msg
            });
            this.loadOrder();
            this.orderId = '';
          } else {
            this.$message.error(resp.data.msg);
          }
        })
      }).catch(() => {

      });
    },
    cancelEidt() {
      this.dialogVisible = false;
    },
    cancelOrderTimeEidt() {
      this.orderTimeDialogVisible = false;
    },
    cancelOrderTalkEidt() {
      this.orderTalkFormDialogVisible = false;
    },
    cancelOrderModeEidt() {
      this.orderModeDialogVisible = false;
    },
    cancelEditOrderModeEidt() {
      this.editOrderModeDialogVisible = false;
    },
    cancelSharePwdModeEidt() {
      this.sharePwdFormDialogVisible = false;
    },
    cancelEditSharePwdModeEidt() {
      this.shareEditPwdFormDialogVisible = false;
    },
    formateDistributionMode(row) {
      if (row.distributionMode === 1) {
        return this.$createElement('span', { style: { color: '#F56C6C' } }, '在线账号');
      } else {
        return this.$createElement('span', { style: { color: '#67C23A' } }, '全站分配');
      }
    },
    formateStatus(row) {
      if (row.status === 1) {
        return this.$createElement('el-button', { props: { type: 'success', size: 'mini', plain: true, disabled: true } }, '正常');
      } else if (row.status === 2) {
        return this.$createElement('el-button', { props: { type: 'warning', size: 'mini', plain: true, disabled: true } }, '关闭');
      } else if (row.status === 3) {
        return this.$createElement('el-button', { props: { type: 'danger', size: 'mini', plain: true, disabled: true } }, '过期');
      } else if (row.status === 4) {
        return this.$createElement('el-button', { props: { type: 'info', size: 'mini', plain: true, disabled: true } }, '删除');
      }
    },
    handleSelectionChange(selection) {
      if (selection.length > 0) {
        var orderNumsVal = '';
        var orderIdVal = '';
        for (var i = 0; i < selection.length; i++) {
          orderNumsVal += selection[i].serialNumber + ",";
          orderIdVal += selection[i].id + ",";
        }
        this.orderId = orderIdVal.substring(0, orderIdVal.length - 1);
        this.orderNums = orderNumsVal.substring(0, orderNumsVal.length - 1);
        this.orderTimeBtnFlag = false;
        this.orderCloseFlag = false;
      } else {
        this.orderTimeBtnFlag = true;
        this.orderCloseFlag = true;
      }
    },
    resetForm(formName) {
      this.$refs[formName].resetFields();
    },
    addOrder(formName) {
      this.$refs[formName].validate((valid) => {
        if (valid) {
          //添加
          this.tableLoading = true;
          this.postRequest("/order/editOrder?orderOperates=add", this.order).then(resp => {
            this.tableLoading = false;
            if (resp && resp.status == 200) {
              var data = resp.data;
              if (data.success == "error") {
                this.$message({type: data.success, message: data.msg});
                return;
              }
              this.$message({type: data.success, message: data.msg});
              this.dialogVisible = false;
              this.resetForm('addOrderForm');
              this.loadOrder();
            }
          })
        } else {
          return false;
        }
      });
    },
    exportOrder() {
      window.open("/apis/export2/orderExport?orderNums=" + this.orderNums + "", "_parent");
    },
    deleteEmp(row) {
      this.$confirm('此操作将永久删除[' + row.name + '], 是否继续?', '提示', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }).then(() => {
        this.doDelete(row.id);
      }).catch(() => {
      });
    },
    searchOrder() {
      this.loadOrder();
    },
    currentChange(currentChange) {
      this.currentPage = currentChange;
      this.loadOrder();
    },
    handleSizeChange(val) {
      this.rows = val;
    },
    loadOrder() {
      var _this = this;
      var beginTime = "";
      var endTime = "";
      if (this.value.length > 0) {
        beginTime = this.value[0];
        endTime = this.value[1];
      }
      this.tableLoading = true;
      this.postRequest("/order/getOrder", {
        "page": this.currentPage,
        "rows": this.rows,
        "beginTime": beginTime,
        "endTime": endTime,
        "serialNumber": this.searchOrderNum,
        "status": this.searchStatus,
        "nickName": this.searchNickName,
        "title": this.searchTitle
      }).then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          var data = resp.data;
          _this.orders = data.rows;
          this.totalCount = data.total;
        }
      })
    },
    showAddEmpView() {
      this.dialogTitle = "创建工单";
      this.dialogVisible = true;
    },
    dateFormat(fmt, date) {
      let ret;
      const opt = {
        "y+": date.getFullYear().toString(),        // 年
        "m+": (date.getMonth() + 1).toString(),     // 月
        "d+": date.getDate().toString(),            // 日
        "H+": date.getHours().toString(),           // 时
        "M+": date.getMinutes().toString(),         // 分
        "s+": date.getSeconds().toString()          // 秒
        // 有其他格式化字符需求可以继续添加，必须转化成字符串
      };
      for (let k in opt) {
        ret = new RegExp("(" + k + ")").exec(fmt);
        if (ret) {
          fmt = fmt.replace(ret[1], (ret[1].length == 1) ? (opt[k]) : (opt[k].padStart(ret[1].length, "0")))
        }
        ;
      }
      ;
      return fmt;
    },
    showOrder(data) {
      let expirationTime = new Date(data.expirationTime);
      expirationTime = this.dateFormat("yyyy-MM-dd HH:mm:ss", expirationTime);
      this.$router.push({
        path: '/order/details',
        query: {
          orderNum: data.serialNumber,
          expirationTime: expirationTime,
          type: data.type,
          title: data.title,
          status: data.status,
          zeroTime: data.zeroTime
        }
      })
    },
    setSharePwd(data) {
      this.sharePwdFormDialogVisible = true;
      this.updateOrderId = data.id;
      this.showOrderNums = data.serialNumber;
      this.order.sharePassword = data.sharePassword;
    },
    handleChange(value) {
      if (value != 24 && value != 72 && value != 168 && value != 720) {
        this.radio = '';
      } else {
        this.radio = (value / 24) + "";
      }
    },
    editSharePwd() {
      if (this.order.sharePassword) {
        this.tableLoading = true;
        this.postRequest("/order/updateSharePwd", {
          "id": this.updateOrderId,
          "hours": this.hours,
          "sharePassword": this.order.sharePassword
        }).then(resp => {
          this.tableLoading = false;
          if (resp && resp.status == 200) {
            this.sharePwdFormDialogVisible = false;
            this.loadOrder();
            this.updateOrderId = '';
            this.shareOrder();
          }
        })
      } else {
        this.$message.error('请输入分享密码');
      }
    },
    updateSharePwd() {
      if (this.order.sharePassword) {
        this.tableLoading = true;
        this.postRequest("/order/editSharePwd", {
          "orderIds": this.orderId,
          "sharePassword": this.order.sharePassword
        }).then(resp => {
          this.tableLoading = false;
          if (resp && resp.status == 200) {

            this.$message({
              type: 'success',
              message: resp.data.msg
            });

            this.shareEditPwdFormDialogVisible = false;
            this.loadOrder();
            this.orderId = '';
          } else {
            this.$message.error(resp.data.msg);
          }
        })
      } else {
        this.$message.error('请输入分享密码');
      }
    },
    shareOrder() {
      let url = window.location.protocol + "//" + document.domain + "/#/order/shareDetails?orderNum=" + this.showOrderNums;
      let copyText = "链接： " + url + " \n密码：" + this.order.sharePassword + "\n工单号：" + this.showOrderNums;
      this.copyText = copyText;
      const h = this.$createElement;
      const content = h('div', [
        h('p', '链接：' + url),
        h('p', '密码：' + String(this.order.sharePassword || '')),
        h('p', '工单号：' + String(this.showOrderNums || ''))
      ]);
      this.$alert(content, '分享工单', {
        confirmButtonText: '确定',
        callback: action => {
          let input = document.createElement("textarea"); // 直接构建input
          input.value = this.copyText; // 设置内容
          document.body.appendChild(input); // 添加临时实例
          input.select(); // 选择实例内容
          document.execCommand("Copy"); // 执行复制
          document.body.removeChild(input); // 删除临时实例
          this.$message({
            type: 'info',
            message: `复制成功`
          });
        }
      });
    }
  }
};
</script>
<style scoped>

@media screen and (max-width: 500px){
  #phoneBtn, #phoneColumn, #phoneSearch {
    display: block !important;
  }
  #pcSearch, #pcBtn, #pcColumn, #pcDataSearch{
    display: none;
  }

  #exportBtn{
    float: right;
  }
}

.el-dialog__body {
  padding-top: 0px;
  padding-bottom: 0px;
}

.slide-fade-enter-active {
  transition: all .8s ease;
}

.slide-fade-leave-active {
  transition: all .8s cubic-bezier(1.0, 0.5, 0.8, 1.0);
}

.slide-fade-enter, .slide-fade-leave-to {
  transform: translateX(10px);
  opacity: 0;
}

.popper-dropdown {
  min-width: 130px;
  position: absolute !important;
  top: 35px !important;
  left: 0px !important;
}

.el-radio{
  margin-right: 14px;
}
</style>
