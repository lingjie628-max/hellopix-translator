<template>
  <div>
    <el-container>
      <el-header style="text-align: left;height: auto; padding: 0;">
        <div>
          <el-tag type="success"
                  style="margin-bottom: 10px;width: 100%;text-align: center;font-size: 14px;height: 40px;padding:6px;margin-top:-10px"
                  size="medium">
            工单号：{{ this.$route.query.orderNum }}&nbsp;&nbsp;&nbsp;&nbsp;
            工单到期时间：{{ this.expirationTime }}&nbsp;&nbsp;&nbsp;&nbsp;
            工单类型：{{ this.type }}&nbsp;&nbsp;&nbsp;&nbsp;
            工单名称：{{ this.title }}&nbsp;&nbsp;&nbsp;&nbsp;
            工单状态：<span>{{ this.status | formateStatus }}</span>&nbsp;&nbsp;&nbsp;&nbsp;
            置零时间：<span>
							<el-tooltip class="item" effect="dark" :content="'每天' + zeroTime +'单日目标已完成数自动置零'" placement="top-start">
								<i class="el-icon-s-opportunity" title=""></i>
							</el-tooltip>{{ this.zeroTime }}
						  </span>&nbsp;&nbsp;&nbsp;&nbsp;
            链接失效时间：<span>{{ this.passwordExpirationTime | formatDateTime }}</span>
          </el-tag>
        </div>
        <div>
          <el-button icon="el-icon-arrow-left" @click="back">返回</el-button>
          <span style="display: none;">{{ this.$route.query.orderNum }}</span>
          账号：
          <el-input placeholder="请输入账号" clearable v-model="searchAccount"
                    style="width: 300px;margin: 0px;padding: 0px;"></el-input>
          昵称：
          <el-input placeholder="请输入昵称" clearable v-model="searchNickname"
                    style="width: 300px;margin: 0px;padding: 0px;"></el-input>
          端口号：
          <el-input placeholder="请输端口号" clearable v-model="searchWsid"
                    style="width: 300px;margin: 0px;padding: 0px;"></el-input>
          <el-button type="primary" style="margin-left: 5px" icon="el-icon-search" @click="loadOrderDetails">搜索
          </el-button>
          <el-link type="primary" :underline="false"><i
            class="el-icon-download"></i>本地演示
          </el-link>
        </div>
        <div style="margin-top: 10px;">
			<span style="font-size: 14px;color:var(--w-accent)">
            <span>工单重置后进粉总数（已去重）：{{ totalFansCount }}</span>
            <span style="margin-left: 20px">当日总进粉（已去重）：{{ todayFansCount }}</span>
            <span style="margin-left: 20px">当日总重粉：{{ todayRepFansCount }}</span>
      </span>
        </div>
      </el-header>
      <el-main style="padding-left: 0px;padding-top: 10px">
        <div>
          <el-table :data="orderDetails" v-loading="tableLoading" border stripe style="width: 100%">
            <el-table-column type="selection" align="center" width="30"></el-table-column>
            <el-table-column prop="orderNum" align="center" fixed label="工单号" width="150px"></el-table-column>
            <el-table-column prop="wsid" align="center" fixed label="端口号" width="290px"></el-table-column>
            <el-table-column prop="account" align="center" fixed label="账户" width="200px"></el-table-column>
            <el-table-column prop="nickName" align="center" fixed label="昵称"></el-table-column>
            <el-table-column prop="completedDayTarget,dayTarget" align="center" fixed label="已完成/单日目标" width="130px">
              <template slot-scope="scope"> {{ scope.row.completedDayTarget }}/{{ scope.row.dayTarget }}</template>
            </el-table-column>
            <el-table-column prop="completedTotalTarget,totalTarget" align="center" fixed label="已完成/总目标" width="130px">
              <template slot-scope="scope"> {{ scope.row.completedTotalTarget }}/{{ scope.row.totalTarget }}</template>
            </el-table-column>
            <el-table-column prop="repeatQuantity" align="center" fixed label="重粉数"></el-table-column>
            <el-table-column prop="lastLogintime" align="center" fixed label="最后登录时间" width="180px">
              <template slot-scope="scope">
                <el-link type="success" :underline="false">{{ scope.row.lastLogintime | formatDateTime }}</el-link>
              </template>
            </el-table-column>
            <el-table-column prop="lastTime,offlineTime" align="center" fixed label="上次上线/下线时间" width="180px">
              <template slot-scope="scope">
                <el-link type="success" :underline="false">{{ scope.row.lastTime | formatDateTime }}</el-link>
                <br>
                <el-link type="danger" :underline="false"> {{ scope.row.offlineTime | formatDateTime }}</el-link>
              </template>
            </el-table-column>
            <el-table-column prop="occupied" align="center" fixed label="是否占用" :formatter="formateOccupied"
                             width="100px" :filters="[{ text: '是', value: 1 }, { text: '否', value: 0 }]"
                             :filter-method="filterOccupiedHandler"></el-table-column>
            <el-table-column prop="onlineStatus" align="center" fixed label="是否在线" width="100px"
                             :formatter="formateOnlineStatus"
                             :filters="[{ text: '在线', value: 1 }, { text: '离线', value: 0 }]"
                             :filter-method="filterOnlineStatusHandler"></el-table-column>
            <el-table-column prop="distribution" align="center" fixed label="是否分配" width="100px"
                             :formatter="formateDistribution"
                             :filters="[{ text: '是', value: 1 }, { text: '否', value: 0 }]"
                             :filter-method="filterDistributionHandler"></el-table-column>

            <el-table-column prop="version" align="center" fixed label="版本"></el-table-column>
            <el-table-column fixed="right" label="操作" align="center" width="120px">
              <template slot-scope="scope">
                <el-button @click="showOrderFans(scope.row)" type="primary" icon="el-icon-message" circle
                           title="粉丝明细"></el-button>
              </template>
            </el-table-column>
          </el-table>
          <div style="display: flex;justify-content: space-between;margin: 2px">
            <div class="block">
              <el-pagination @size-change="handleSizeChange" @current-change="currentChange" :current-page="currentPage"
                             :page-sizes="[10, 20, 50, 100]" :page-size="rows"
                             layout="total, sizes, prev, pager, next, jumper"
                             :total="totalCount">
              </el-pagination>
            </div>
          </div>
        </div>
      </el-main>
    </el-container>

    <el-form ref="sharePwdForm" style="margin: 0px;padding: 0px;">
      <div style="text-align: left">
        <el-dialog title="校验密码" style="padding: 0px;" :close-on-click-modal="false"
                   :visible.sync="sharePwdFormDialogVisible" width="520px">
          <el-row>
            <el-col>
              <div>
                <el-form-item label="分享密码: ">
                  <el-input type="text" placeholder="请输入分享密码" oninput="value=value.replace(/[^0-9,a-z,A-Z]/g, '')"
                            v-model="sharePassword" style="width:300px" maxlength="10" show-word-limit></el-input>
                </el-form-item>
              </div>
            </el-col>
          </el-row>
          <span slot="footer" class="dialog-footer">
				<el-button @click="cancelEditSharePwdModeEidt">取 消</el-button>
				<el-button type="primary" @click="checkSharePwd()">确 定</el-button>
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
      orderDetails: [],
      wsids: '',
      searchOrderNum: this.$route.query.orderNum,
      type: '',
      status: '',
      title: '',
      expirationTime: '',
      searchNickname: '',
      searchAccount: '',
      searchWsid: '',
      sharePassword: '',
      tableLoading: false,
      sharePwdFormDialogVisible: false,
      passwordExpirationTime: '',
      zeroTime: '',
      serverTime: '',
      totalCount: -1,
      currentPage: 1,
      todayFansCount: 0,
      todayRepFansCount: 0,
      totalFansCount: 0,
      checkPwd: false,
      rows: 10
    };
  },
  mounted: function () {
    if (!this.checkPwd) {
      this.showCheckPassword();
    }
  },
  filters: {
    formateStatus(data) {
      if (data === 1) {
        return "正常";
      } else if (data === 2) {
        return "关闭"
      } else if (data === 3) {
        return "过期"
      } else if (data === 4) {
        return "删除"
      }
    }
  },
  methods: {
    cancelEditSharePwdModeEidt() {
      this.sharePwdFormDialogVisible = false;
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
    showCheckPassword() {
      if (!localStorage.getItem("sharePwd_" + this.searchOrderNum)) {
        this.sharePwdFormDialogVisible = true;
      } else {
        this.loadOrder();
      }
    },
    loadServerTime() {
      this.postRequest("/order/getServerTime", {}).then(resp => {
        if (resp && resp.status == 200) {
          var data = resp.data.data;
          this.serverTime = data;
        }
      });
    },
    loadOrder() {
      this.loadServerTime();
      this.postRequest("/order/selectOrderBySerialNumber", {"serialNumber": this.searchOrderNum}).then(resp => {
        if (resp && resp.status == 200) {
          var data = resp.data.data;
          this.zeroTime = data.zeroTime;
          this.passwordExpirationTime = data.passwordExpirationTime;

          if (this.passwordExpirationTime < this.serverTime) {
            this.$message.error("工单分享已过期");
            return;
          }

          this.loadOrderDetails();
          this.getTodayFansCount();
        }
      });
    },
    checkSharePwd() {
      if (this.sharePassword) {
        this.postRequest("/order/checkSharePwd", {
          "sharePassword": this.sharePassword,
          "serialNumber": this.searchOrderNum
        }).then(resp => {
          if (resp && resp.status == 200) {
            var data = resp.data;
            if (data.code === 200) {
              this.loadServerTime();
              this.sharePwdFormDialogVisible = false;
              this.zeroTime = data.msg;
              this.passwordExpirationTime = data.data;
              localStorage.setItem("shareToken_" + this.searchOrderNum, data.token);
              if (new Date(data.data).getTime() < this.serverTime) {
                this.$message.error("工单分享已过期");
                this.checkPwd = false;
                return;
              }

              this.checkPwd = true;
              this.loadOrderDetails();
              this.getTodayFansCount();
              return;
            } else {
              this.$message.error(data.msg);
              this.checkPwd = false;
              localStorage.removeItem("shareToken_" + this.searchOrderNum);
              return;
            }
          } else {
            this.$message.error(data.msg);
            this.checkPwd = false;
            localStorage.removeItem("shareToken_" + this.searchOrderNum);
            return;
          }
        })
      } else {
        this.$message.error("请输入校验密码");
      }
    },
    getTodayFansCount() {
      this.postRequest("/orderDetails/getTodayFansCount", {
        "serialNumber": this.searchOrderNum,
        "shareToken": localStorage.getItem("shareToken_" + this.searchOrderNum) || ""
      }).then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          let data = resp.data.data;
          this.todayFansCount = data.todayFansCount;
          this.todayRepFansCount = data.todayRepFansCount;
          this.totalFansCount = data.totalFansCount;
        }
      })
    },
    back() {
      this.$router.go(-1);//返回上一层
    },
    showOrderFans(data) {
      this.$router.push({
        path: '/order/shareFans', query: {
          orderNum: this.$route.query.orderNum,
          expirationTime: this.expirationTime,
          loginAccount: data.account,
          type: this.type,
          title: this.title,
          status: this.status,
          zeroTime: this.zeroTime,
          passwordExpirationTime: this.passwordExpirationTime
        }
      })
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
    exportOrderDetails() {
      if (localStorage.getItem("shareToken_" + this.searchOrderNum) && this.passwordExpirationTime > this.serverTime) {
        window.open("/apis/export/orderDetailExport?orderNum=" + this.searchOrderNum + "&account=" + this.searchAccount + "&wsid=" + this.searchWsid + "", "_parent");
      }
    },
    currentChange(currentChange) {
      this.currentPage = currentChange;
      this.loadOrderDetails();
    },
    handleSizeChange(val) {
      this.rows = val;
    },
    loadOrderDetails() {
      if (localStorage.getItem("sharePwd_" + this.searchOrderNum) && this.passwordExpirationTime > this.serverTime) {
        this.tableLoading = true;
        this.postRequest("/orderDetails/shareOrder", {
          "page": this.currentPage,
          "rows": this.rows,
          "orderNum": this.searchOrderNum,
          "shareToken": localStorage.getItem("shareToken_" + this.searchOrderNum) || "",
          "wsid": this.searchWsid,
          "account": this.searchAccount,
          "nickName": this.searchNickname
        }).then(resp => {
          this.tableLoading = false;
          if (resp && resp.status == 200) {
            var data = resp.data;
            this.orderDetails = data.rows;
            this.totalCount = data.total;
            this.title = data.object.title;
            this.expirationTime = data.object.expirationTime;
            this.type = data.object.type;
            this.status = data.object.status;
          }
        })
      }
    },
  }
};
</script>
<style>
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
</style>
