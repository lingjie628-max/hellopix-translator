<template>
  <div>
    <el-container>
      <el-header style="text-align: left;height: auto; padding: 0;">
        <div>
          <el-tag type="success"
                  style="margin-bottom: 10px;width: 100%;text-align: center;font-size: 14px;height: 40px;padding:6px;margin-top:-10px"
                  size="medium" id="pcTag">
            工单号：{{ this.$route.query.orderNum }}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            工单到期时间：{{ this.$route.query.expirationTime }}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            工单类型：{{ this.$route.query.type }}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            工单名称：{{ this.$route.query.title }}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            工单状态：<span>{{ this.$route.query.status | formateStatus }}</span>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            置零时间：<span>
							<el-tooltip class="item" effect="dark" :content="'每天' + zeroTime +'单日目标已完成数自动置零'" placement="top-start">
								<i class="el-icon-s-opportunity" title=""></i>
							</el-tooltip>{{ this.$route.query.zeroTime }}
						  </span>
          </el-tag>

          <el-tag type="success"
                  style="margin-bottom: 10px;width: 100%;text-align: center;font-size: 14px;height: 115px;padding:6px;margin-top:-10px;display: none"
                  size="medium" id="phoneTag" v-if="showInfoTag">
            <span style="float: left">工单号：{{ this.$route.query.orderNum }} [{{ this.$route.query.status | formateStatus }}]</span>
            <span style="float: right;font-size: 16px"><i class="el-icon-circle-close" @click="hideInfo"></i></span>
            <br>
            <span style="float: left">工单到期时间：{{ this.$route.query.expirationTime }}</span><br>
            <span style="float: left">工单名称：{{ this.$route.query.title }}</span><br>
            <span style="float: left">工单类型：{{ this.$route.query.type }}</span>
            <span style="float: right">置零时间：
							<el-tooltip class="item" effect="dark" :content="'每天' + zeroTime +'单日目标已完成数自动置零'" placement="top-start">
								<i class="el-icon-s-opportunity" title="" style="margin-right: 5px;"></i>
							</el-tooltip>{{ this.$route.query.zeroTime}}
						  </span>
          </el-tag>
        </div>
        <div id="pcSearch">
          <el-button icon="el-icon-arrow-left" @click="back">返回</el-button>
          <span style="display: none;">{{ this.$route.query.orderNum }}</span>
          账号：
          <el-input placeholder="请输入账号" clearable v-model="searchAccount"
                    style="width: 300px;margin: 0px;padding: 0px;"></el-input>
          昵称：
          <el-input placeholder="请输入昵称" clearable v-model="searchNickname"
                    style="width: 300px;margin: 0px;padding: 0px;"></el-input>
          备注：
          <el-input placeholder="请输入备注" clearable v-model="searchRemarks"
                    style="width: 300px;margin: 0px;padding: 0px;"></el-input>
          <el-button type="primary" style="margin-left: 5px;margin-top: 10px" icon="el-icon-search" @click="loadOrderDetails" >搜索</el-button>
          <el-button type="primary" icon="el-icon-refresh" @click="unbindPortMethod" :disabled="btnPort" id="phone_sfdk" style="float: right;display: none;margin-top: 10px;">端口释放</el-button>
        </div>

        <div id="phoneSearch" style="display: none">
          <el-button icon="el-icon-arrow-left" @click="back" style="padding: 12px">返回</el-button>
          <el-select v-model="value" clearable placeholder="请选择" style="width: 100px">
            <el-option
              v-for="item in options"
              :key="item.value"
              :label="item.label"
              :value="item.value">
            </el-option>
          </el-select>
          <el-input  clearable v-model="phoneSearch" style="width: 170px;margin: 0px;padding: 0px;"></el-input>
          <el-button type="primary" style="margin-left: 5px;margin-top: 10px" icon="el-icon-search" @click="loadPhoneOrderDetails" >搜索</el-button>
          <el-button type="primary" icon="el-icon-refresh" @click="unbindPortMethod" :disabled="btnPort" id="phone_sfdk" style="float: right;display: none;margin-top: 10px;">端口释放</el-button>
        </div>

        <div style="margin-top:10px;">
          <div id="pcBtn">
            <el-button type="primary" icon="el-icon-refresh" @click="unbindPortMethod" :disabled="btnPort">端口释放</el-button>
            <el-button type="warning" icon="el-icon-folder-add" @click="setDistributionMethod(1)" :disabled="btnOpen">开启分配</el-button>
            <el-button type="info" icon="el-icon-folder-delete" @click="setDistributionMethod(0)" :disabled="btnClose">关闭分配</el-button>
            <el-button type="danger" icon="el-icon-delete" @click="deleteOrderDetails()" :disabled="btnClose">删除主号</el-button>
            <el-button type="success" icon="el-icon-plus" @click="shuntLink()" v-if="isShow">生成分流链接</el-button>
            <el-button type="success" icon="el-icon-document-copy" @click="shuntLinkOption()" v-if="isShow">分流链接管理</el-button>
            <el-button type="danger" icon="el-icon-refresh-left" @click="resetOrderDetails()" :disabled="btnClose">重置工单明细</el-button>
          </div>

          <div id="phoneBtn" style="display: none">
            <table width="100%">
              <tr>
                <td><el-button type="warning" icon="el-icon-folder-add" @click="setDistributionMethod(1)" :disabled="btnOpen">开启分配</el-button></td>
                <td align="right"><el-button type="info" icon="el-icon-folder-delete" @click="setDistributionMethod(0)" :disabled="btnClose">关闭分配</el-button></td>
              </tr>
              <tr>
                <td><el-button type="danger" icon="el-icon-delete" @click="deleteOrderDetails()" :disabled="btnClose">删除主号</el-button></td>
                <td align="right"><el-button type="danger" icon="el-icon-refresh-left" @click="resetOrderDetails()" :disabled="btnClose">重置工单明细</el-button></td>
              </tr>
              <tr>
                <td><el-button type="success" icon="el-icon-document-copy" @click="shuntLinkOption()" v-if="isShow">分流链接管理</el-button></td>
                <td align="right"><el-button type="success" icon="el-icon-plus" @click="shuntLink()" v-if="isShow">生成分流链接</el-button></td>
              </tr>
            </table>
          </div>

          <div data-v-5b9fd231="" v-show="isShow" class="selection el-col el-col-24"
               style="font-size: 14px;display:contents">
            工单支持获取主号进行分配功能，可用于推广时每次展示此工单内不同主号。
            <button @click="getLink()" type="button" class="el-button el-button--text">
              <span>点击获取推广链接，需科学上网。 </span>
            </button>
          </div>
        </div>

        <div style="margin-top: 10px;" id="pcInfo">
          <span style="font-size: 14px;color:var(--w-accent)">
            <span>工单重置后进粉总数（已去重）：{{ totalFansCount }}</span>
            <span style="margin-left: 20px">当日总进粉（已去重）：{{ todayFansCount }}</span>
            <span style="margin-left: 20px">当日总重粉：{{ todayRepFansCount }}
            </span>
          </span>
        </div>

        <div style="margin-top: 10px;display:none;" id="phoneInfo">
          <span style="font-size: 14px;color:var(--w-accent)">
            <table>
              <tr>
                <td colspan="2">工单重置后进粉总数（已去重）：{{ totalFansCount }}</td>
              </tr>
              <tr>
                <td>当日总进粉（已去重）：{{ todayFansCount }}</td>
                <td>当日总重粉：{{ todayRepFansCount }}</td>
              </tr>
            </table>
          </span>
        </div>

      </el-header>

      <el-main style="padding-left: 0px;padding-top: 10px">
        <div>
          <el-table :data="orderDetails" v-loading="tableLoading" border stripe
                    @selection-change="handleSelectionChange" style="width: 100%">
            <el-table-column type="selection" align="center" fixed width="30"></el-table-column>
            <el-table-column prop="account" align="center"  label="账户" width="200px"></el-table-column>
            <el-table-column prop="occupied" align="center"  label="是否占用" :formatter="formateOccupied"
                             width="100px" :filters="[{ text: '是', value: 1 }, { text: '否', value: 0 }]"
                             :filter-method="filterOccupiedHandler"></el-table-column>
            <el-table-column prop="onlineStatus" align="center"  label="是否在线" width="100px"
                             :formatter="formateOnlineStatus"
                             :filters="[{ text: '在线', value: 1 }, { text: '离线', value: 0 }]"
                             :filter-method="filterOnlineStatusHandler"></el-table-column>
            <el-table-column prop="distribution" align="center"  label="是否分配" width="100px"
                             :formatter="formateDistribution"
                             :filters="[{ text: '是', value: 1 }, { text: '否', value: 0 }]"
                             :filter-method="filterDistributionHandler"></el-table-column>

            <el-table-column prop="headImg" align="center"  label="头像">
              <template slot-scope="scope">
                <el-image style="width: 50px; height: 50px; border-radius: 25px;"
                          :onerror="defaultImg" :src="scope.row.headImg ? scope.row.headImg : ''">
                </el-image>
              </template>
            </el-table-column>

            <el-table-column prop="nickName" align="center" label="昵称"></el-table-column>
            <el-table-column prop="remarks" align="center"  label="备注" width="200px">
              <template slot-scope="scope">
                {{ scope.row.remarks }}<i class="el-icon-edit" style="cursor:pointer"
                                          @click="showEditRemarks('show', scope.row.orderNum, scope.row.wsid, scope.row.remarks)"></i>
              </template>
            </el-table-column>
            <el-table-column prop="completedDayTarget,dayTarget" align="center"  label="已完成/单日目标" width="150px"
                             sortable>
              <template slot-scope="scope"> {{ scope.row.completedDayTarget }}/{{ scope.row.dayTarget }}</template>
            </el-table-column>
            <el-table-column prop="completedTotalTarget,totalTarget" align="center"  label="已完成/总目标" width="150px"
                             sortable>
              <template slot-scope="scope"> {{ scope.row.completedTotalTarget }}/{{ scope.row.totalTarget }}</template>
            </el-table-column>
            <el-table-column prop="dayRepeatQuantity" align="center"  label="单日重粉" width="110px"
                             sortable></el-table-column>
            <el-table-column prop="repeatQuantity" align="center"  label="重粉总数" width="110px"
                             sortable></el-table-column>
            <el-table-column prop="lastLogintime" align="center"  label="最后登录时间" width="180px" sortable>
              <template slot-scope="scope">
                <el-link type="success" :underline="false">{{ scope.row.lastLogintime | formatDateTime }}</el-link>
              </template>
            </el-table-column>
            <el-table-column prop="lastTime,offlineTime" align="center"  label="上次上线/下线时间" width="180px">
              <template slot-scope="scope">
                <el-link type="success" :underline="false">{{ scope.row.lastTime | formatDateTime }}</el-link>
                <br>
                <el-link type="danger" :underline="false"> {{ scope.row.offlineTime | formatDateTime }}</el-link>
              </template>
            </el-table-column>
            <el-table-column prop="linkUrl" align="center"  label="推广链接" width="250px">
              <template slot-scope="scope">
                {{ scope.row.linkUrl }} <i class="el-icon-document-copy" style="margin-left:10px;cursor:pointer"
                                           @click="copyLinkUrl(scope.row.linkUrl)"></i>
              </template>
            </el-table-column>
            <el-table-column prop="qrCode" align="center"  label="二维码" width="100px">
              <template slot-scope="scope">
                <el-image style="width: 50px; height: 50px;" :preview-src-list="srcList"
                          @click="setPreviewList(scope.row.qrCode)"
                          :onerror="defaultQrCode"
                          :src="scope.row.qrCode ? 'data:image/png;base64,' + scope.row.qrCode : ''">
                </el-image>
              </template>
            </el-table-column>
            <el-table-column prop="version" align="center"  label="版本"></el-table-column>

            <el-table-column label="操作" align="center" fixed="right" width="180px" v-if="pcColumn">
              <template slot-scope="scope">
                <el-button @click="showOrderFans(scope.row)" type="primary" icon="el-icon-message" circle
                           title="粉丝明细"></el-button>
                <el-button @click="showOrderDetailsLog(scope.row)" type="primary" icon="el-icon-date" circle
                           title="历史记录" plain></el-button>
                <el-button @click="showLoginLog(scope.row)" type="primary" icon="el-icon-document" circle title="登录日志"
                           plain></el-button>
              </template>
            </el-table-column>

            <el-table-column label="操作" align="center" fixed="right" id="phoneColumn" width="80px" v-if="phoneColumn">
              <template slot-scope="scope">
                <table>
                  <tr>
                    <td><el-button @click="showOrderFans(scope.row)" type="primary" icon="el-icon-message" circle title="粉丝明细" size="mini"></el-button></td>
                    <td><el-button @click="showOrderDetailsLog(scope.row)" type="primary" icon="el-icon-date" circle title="历史记录" plain size="mini"></el-button></td>
                  </tr>
                  <tr>
                    <td><el-button @click="showLoginLog(scope.row)" type="primary" icon="el-icon-document" circle title="登录日志" plain size="mini"></el-button></td>
                    <td></td>
                  </tr>
                </table>
              </template>
            </el-table-column>
          </el-table>
          <div style="display: flex;justify-content: space-between;margin: 2px">
            <div class="block">
              <el-pagination @current-change="currentChange" @size-change="handleSizeChange" :current-page="currentPage" v-if="pcColumn"
                             :page-sizes="[10, 20, 50, 100]"
                             :page-size="rows" layout="total, sizes, prev, pager, next,jumper"
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
        <el-form ref="orderTimeForm" style="margin: 0px;padding: 0px;">
          <div style="text-align: left">
            <el-dialog title="修改备注" style="padding: 0px;" :close-on-click-modal="false"
                       :visible.sync="orderDetailsVisible" width="520px">
              <el-row>
                <el-col>
                  <div>
                    <el-input v-model="remarks" placeholder="请输入备注"></el-input>
                  </div>
                </el-col>
              </el-row>
              <span slot="footer" class="dialog-footer">
						<el-button @click="showEditRemarks('hidden')">取 消</el-button>
						<el-button type="primary" @click="saveEditRemarks()">确 定</el-button>
					</span>
            </el-dialog>
          </div>
        </el-form>
      </el-main>
    </el-container>


    <el-form ref="shareLink" style="margin: 0px;padding: 0px;">
      <div style="text-align: left">
        <el-dialog title="生成分流链接" style="padding: 0px;" :close-on-click-modal="false" :visible.sync="shareLinkVis"
                   width="800px">
          <el-row>
            <el-col>
              <div>
                <el-form-item label="功能介绍: ">
                  <el-row>
                    <el-col>
                      分流链接将对工单内主号进行分配轮切，每次访问链接都返回不同主号。
                    </el-col>
                  </el-row>
                  <el-row>
                    <el-col>
                      <div>
                        短链平台：
                        <el-radio-group v-model="platform">
                          <el-badge value="推荐" class="item">
                            <el-radio label="is.gd" v-model="platform">is.gd</el-radio>
                          </el-badge>

                          <el-badge value="" class="item">
                            <el-radio label="tinyurl.com" v-model="platform">tinyurl.com</el-radio>
                          </el-badge>

                          <el-badge value="" class="item">
                            <el-radio label="goo.su" v-model="platform">goo.su</el-radio>
                          </el-badge>

                          <el-badge value="" class="item">
                            <el-radio label="ssur.cc" v-model="platform">ssur.cc</el-radio>
                          </el-badge>
                        </el-radio-group>
                      </div>
                    </el-col>
                  </el-row>
                  <el-row>
                    <el-col>
                      生成模式：
                      <el-radio-group v-model="generate" @change="selectGenerate()">
                        <el-radio label="1" v-model="generate">单个生成</el-radio>
                        <el-radio label="2" v-model="generate">批量生成</el-radio>
                      </el-radio-group>
                    </el-col>
                  </el-row>
                  <el-row>
                    <el-col v-if="this.generate==2">
                      生成数量：
                      <el-input-number v-model="num" :min="1" :max="10" label="生成数量"></el-input-number>
                    </el-col>
                  </el-row>
                  <el-row>
                    <el-col>
                      分配类型：
                      <el-radio-group v-model="type">
                        <el-radio label="1" v-model="type">工单主号分配</el-radio>
                        <el-radio label="2" v-model="type">自定义分配</el-radio>
                      </el-radio-group>
                    </el-col>
                  </el-row>
                  <el-row v-if="this.type==2">
                    <el-col>
                      <ul class="infinite-list" style="overflow:auto; height: 200px;border:  1px solid gray">
                        <li v-for="i in count" class="infinite-list-item" style="list-style: none;margin: 20px">
                          <el-form :rules="rules" label-width="100px" :model="ruleForm" ref="ruleForm">
                            <el-form-item label="账号" prop="accounts">
                              <el-input v-model="ruleForm.accounts[i]" placeholder="请输入账号" style="width: 300px"
                                        oninput="value=value.replace(/[^\d]/g,'')"></el-input>
                              <i class="el-icon-circle-plus-outline" @click="addAccount"></i>
                              <i class="el-icon-remove-outline" @click="deleteAccount(i)"></i>
                            </el-form-item>
                          </el-form>
                        </li>
                      </ul>
                    </el-col>
                  </el-row>
                  <el-row>
                    <el-col v-if="this.type==1">
                      分配模式：
                      <el-radio-group v-model="pattern">
                        <el-radio label="1" v-model="pattern">分配在线账号</el-radio>
                        <el-radio label="2" v-model="pattern">全部分配</el-radio>
                      </el-radio-group>
                    </el-col>
                  </el-row>
                  <el-row>
                    <el-col>
                      <el-tooltip class="item" effect="dark" content="该内容在粉丝打开WhatsApp后会自动输入到消息框中" placement="top">
                        <i class="el-icon-info">文本消息</i>
                      </el-tooltip>
                      <el-input type="textarea" v-model="message" placeholder="请输入文本消息" maxlength="200" rows="5"
                                show-word-limit></el-input>
                    </el-col>
                  </el-row>
                </el-form-item>

              </div>
            </el-col>
          </el-row>
          <span slot="footer" class="dialog-footer">
				<el-button @click="cancelShareLink">取 消</el-button>
				<el-button type="primary" @click="saveShortLink()">确 定</el-button>
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
      options: [{
        value: 'searchAccount',
        label: '账号'
      },{
        value: 'searchNickname',
        label: '昵称'
      },{
        value: 'searchRemarks',
        label: '备注'
      }],
      value:'searchAccount',
      orderDetails: [],
      ruleForm: {
        accounts: [],
      },
      wsids: '',
      wsid: '',
      showInfoTag: true,
      orderNum: '',
      searchOrderNum: this.$route.query.orderNum,
      searchAccount: '',
      searchNickname: '',
      phoneSearch: '',
      searchRemarks: '',
      searchWsid: '',
      remarks: '',
      zeroTime: this.$route.query.zeroTime,
      orderDetailsVisible: false,
      tableLoading: false,
      shareLinkVis: false,
      btnPort: true,
      btnOpen: true,
      btnClose: true,
      totalCount: -1,
      currentPage: 1,
      telphones: '',
      platform: 'is.gd',
      pattern: '1',
      type: '1',
      message: '',
      pcColumn: true,
      phoneColumn: false,
      generate: '1',
      num: '',
      count: 1,
      isShow: true,
      todayFansCount: 0,
      todayRepFansCount: 0,
      totalFansCount: 0,
      rows: 10,
      srcList: [
        require('@/assets/defaultQrcode.jpg')
      ],
      defaultImg: 'this.src="' + require('@/assets/default.png') + '"',
      defaultQrCode: 'this.src="' + require('@/assets/defaultQrcode.jpg') + '"',
      rules: {
        accounts: [
          {required: true, message: '请输入账号', trigger: 'blur'}
        ]
      }
    };
  },
  mounted: function () {
    this.loadOrderDetails();
    this.getTodayFansCount();
    this.isPc();
  },
  filters: {
    formateStatus(data) {
      if (data === '1' || data === 1) {
        return "正常";
      } else if (data === '2' || data === 2) {
        return "关闭"
      } else if (data === '3' || data === 3) {
        return "过期"
      } else if (data === '4' || data === 4) {
        return "删除"
      }
    }
  },
  methods: {
    back() {
      this.$router.go(-1);//返回上一层
    },
    hideInfo(){
      this.showInfoTag = false;
    },
    addAccount() {
      this.count++;
    },
    resetOrderDetails() {
      this.$confirm('确认重置[' + this.telphones + ']账号数据吗？重置后账号下面的所有进粉数据全部清零，请慎重操作!', '提示', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }).then(() => {
        this.postRequest("/orderDetails/resetOrderDetails", {
          wsids: this.wsids,
          orderNum: this.$route.query.orderNum
        }).then(resp => {
          this.tableLoading = false;
          if (resp && resp.status == 200) {
            let data = resp.data;
            this.$message({type: data.success, message: data.msg});
            this.loadOrderDetails();
          }
        })
      }).catch(() => {

      });
    },
    deleteAccount(i) {
      if (this.count <= 1) {
        this.$message({
          type: 'warning',
          message: `至少一个账号`
        });
        return;
      }
      this.ruleForm.accounts.splice(i, 1);
      this.count--;
    },
    copyLinkUrl(value) {
      let input = document.createElement("input"); // 直接构建input
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
    shuntLink() {
      this.shareLinkVis = true;
    },
    cancelShareLink() {
      this.shareLinkVis = false;
    },
    shuntLinkOption() {
      this.$router.push({
        path: '/short/link', query: {orderNum: this.$route.query.orderNum}
      })
    },
    saveShortLink() {
      this.postRequest("/shortLink/addShortLink", {
        "orderNum": this.searchOrderNum,
        "platform": this.platform,
        "type": this.type,
        "pattern": this.pattern,
        "message": this.message,
        "accounts": this.ruleForm.accounts,
        "generate": this.generate,
        "num": this.num
      }).then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          let data = resp.data;
          this.$message({type: data.success, message: data.msg});
          this.loadOrderDetails();
          this.wsid = '';
          this.orderNum = '';
          this.remarks = '';
          this.shareLinkVis = false;
        }
      })
    },
    showEditRemarks(op, orderNum, wsid, remarks) {
      if (op === 'show') {
        this.orderDetailsVisible = true;
        this.orderNum = orderNum;
        this.wsid = wsid;
        this.remarks = remarks;
        return;
      } else {
        this.orderDetailsVisible = false;
      }
    },
    saveEditRemarks() {
      this.postRequest("/orderDetails/updateRemarks", {
        "orderNum": this.orderNum,
        "wsid": this.wsid,
        "remarks": this.remarks
      }).then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          var data = resp.data;
          this.$message({type: data.success, message: data.msg});
          this.loadOrderDetails();
          this.wsid = '';
          this.orderNum = '';
          this.remarks = '';
          this.orderDetailsVisible = false;
        }
      })
    },
    setDetaultCode() {
      if (this.srcList.length == 0) {
        this.srcList.push("data:image/png;base64," + value);
      }
    },
    setPreviewList(value) {
      this.srcList.splice(0, this.srcList.length);	//清空数据
      this.srcList.push("data:image/png;base64," + value);
    },
    filterOccupiedHandler(value, row) {
      return row.occupied === value;
    },
    filterOnlineStatusHandler(value, row) {
      return row.onlineStatus === value;
    },
    filterDistributionHandler(value, row) {
      return row.Distribution === value;
    },
    getTodayFansCount() {
      this.postRequest("/orderDetails/getTodayFansCount", {"serialNumber": this.searchOrderNum}).then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          let data = resp.data.data;
          this.todayFansCount = data.todayFansCount;
          this.todayRepFansCount = data.todayRepFansCount;
          this.totalFansCount = data.totalFansCount;
        }
      })
    },
    showOrderDetailsLog(data) {
      this.$router.push({
        path: '/order/detailsLog', query: {
          orderNum: this.$route.query.orderNum,
          expirationTime: this.$route.query.expirationTime,
          wsid: data.wsid,
          type: this.$route.query.type,
          title: this.$route.query.title,
          status: this.$route.query.status
        }
      })
    },
    deleteOrderDetails() {
      this.$confirm('是否删除[' + this.telphones + ']主号，请慎重操作!', '提示', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }).then(() => {
        this.postRequest("/orderDetails/deleteOrderDetails", {
          orderNum: this.$route.query.orderNum,
          wsid: this.wsids
        }).then(resp => {
          this.tableLoading = false;
          var data;
          if (resp && resp.status == 200) {
            data = resp.data;
            this.loadOrderDetails();
          }
          this.$message({type: data.success, message: data.msg});
        })
      }).catch(() => {

      });
    },
    getLink() {
      let url = window.location.protocol + "//" + document.domain + ":" + window.location.port + "/apis/orderDetails/jump?serialNumber=" + this.searchOrderNum;
      this.copyText = url;
      this.$alert(url, '分享工单', {
        confirmButtonText: '确定',
        callback: action => {
          var input = document.createElement("input"); // 直接构建input
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
    },
    showLoginLog(data) {
      this.$router.push({
        path: '/order/userLogin', query: {
          orderNum: this.$route.query.orderNum,
          expirationTime: this.$route.query.expirationTime,
          loginAccount: data.account,
          type: this.$route.query.type,
          title: this.$route.query.title,
          status: this.$route.query.status
        }
      })
    },
    showOrderFans(data) {
      this.$router.push({
        path: '/order/fans', query: {
          orderNum: this.$route.query.orderNum,
          expirationTime: this.$route.query.expirationTime,
          loginAccount: data.account,
          type: this.$route.query.type,
          title: this.$route.query.title,
          status: this.$route.query.status
        }
      })
    },
    unbindPortMethod() {
      this.$confirm('是否释放该端口[' + this.wsids + '], 是否继续?', '提示', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }).then(() => {
        this.postRequest("/orderDetails/unbindPort", {orderNum: this.searchOrderNum, wsid: this.wsids}).then(resp => {
          this.tableLoading = false;
          var data;
          if (resp && resp.status == 200) {
            data = resp.data;
            this.loadOrderDetails();
          }
          this.$message({type: data.success, message: data.msg});
        })
      }).catch(() => {

      });
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
    handleSelectionChange(selection) {
      if (selection.length > 0) {
        var wsidVal = '';
        var phoneVal = '';
        for (var i = 0; i < selection.length; i++) {
          wsidVal += selection[i].wsid + ",";
          phoneVal += selection[i].account + ",";
        }
        this.telphones = phoneVal.substring(0, phoneVal.length - 1);
        this.wsids = wsidVal.substring(0, wsidVal.length - 1);
        this.btnPort = false;
        this.btnOpen = false;
        this.btnClose = false;
      } else {
        this.btnPort = true;
        this.btnOpen = true;
        this.btnClose = true;
      }
    },
    formateOccupied(row) {
      if (row.occupied === 1) {
        return this.$createElement('el-tag', { props: { type: 'success' } }, '是');
      } else {
        return this.$createElement('el-tag', { props: { type: 'danger' } }, '否');
      }
    },
    formateOnlineStatus(row) {
      if (row.onlineStatus === 1) {
        return this.$createElement('el-tag', { props: { type: 'success' } }, '在线');
      } else {
        return this.$createElement('el-tag', { props: { type: 'danger' } }, '离线');
      }
    },
    formateDistribution(row) {
      if (row.distribution === 1) {
        return this.$createElement('el-tag', { props: { type: 'success' } }, '是');
      } else {
        return this.$createElement('el-tag', { props: { type: 'danger' } }, '否');
      }
    },
    setDistributionMethod(value) {
      if (this.wsids.split(",").length > 1) {
        this.$alert('只能分配一个。', '提醒', {
          confirmButtonText: '确定',
          callback: action => {

          }
        });
        return;
      }

      this.postRequest("/orderDetails/setDistribution", {
        orderNum: this.searchOrderNum,
        wsid: this.wsids,
        distribution: value
      }).then(resp => {
        this.tableLoading = false;
        var data;
        if (resp && resp.status == 200) {
          data = resp.data;
          this.loadOrderDetails();
        }
        this.$message({type: data.success, message: data.msg});
      })
    },
    exportOrderDetails() {
      window.open("/apis/export/orderDetailExport?orderNum=" + this.searchOrderNum + "&account=" + this.searchAccount + "&wsid=" + this.searchWsid + "", "_parent");
    },
    currentChange(currentChange) {
      this.currentPage = currentChange;
      this.loadOrderDetails();
    },
    handleSizeChange(val) {
      this.rows = val;
    },
    loadPhoneOrderDetails(){
      this.tableLoading = true;
      if(this.value === "searchAccount"){
        this.searchAccount = this.phoneSearch;
        this.searchNickname = "";
        this.searchRemarks = "";
      }else if(this.value === "searchNickname"){
        this.searchNickname = this.phoneSearch;
        this.searchAccount = "";
        this.searchRemarks = "";
      }else if(this.value === "searchRemarks"){
        this.searchRemarks = this.phoneSearch;
        this.searchAccount = "";
        this.searchNickname = "";
      }
      this.postRequest("/orderDetails/getOrderDetails", {
        "page": this.currentPage,
        "rows": this.rows,
        "orderNum": this.searchOrderNum,
        "wsid": this.searchWsid,
        "account": this.searchAccount,
        "nickName": this.searchNickname,
        "remarks": this.searchRemarks
      }).then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          let data = resp.data;
          this.orderDetails = data.rows;
          this.totalCount = data.total;
        }
      })
      if (this.$route.query.type != "whatsApp") {
        this.isShow = false;
      } else {
        this.isShow = true;
      }
    },
    loadOrderDetails() {
      this.tableLoading = true;
      this.postRequest("/orderDetails/getOrderDetails", {
        "page": this.currentPage,
        "rows": this.rows,
        "orderNum": this.searchOrderNum,
        "wsid": this.searchWsid,
        "account": this.searchAccount,
        "nickName": this.searchNickname,
        "remarks": this.searchRemarks
      }).then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          let data = resp.data;
          this.orderDetails = data.rows;
          this.totalCount = data.total;
        }
      })

      if (this.$route.query.type != "whatsApp") {
        this.isShow = false;
      } else {
        this.isShow = true;
      }
    },
  }
};
</script>
<style>

@media screen and (max-width: 500px){
  #phoneBtn, #phone_sfdk, #phoneInfo, #phoneTag, #phoneSearch {
    display: block !important;
  }
  #pcBtn, #pcInfo, #pcTag, #pcSearch{
    display: none;
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

.item {
  display: inline-block;
  margin-right: 40px;
}
</style>
