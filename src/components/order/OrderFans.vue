<template>
  <div>
    <el-container>
      <el-header style="text-align: left;height: auto; padding: 0;">
        <div>
          <el-tag type="success"
                  style="margin-bottom: 10px;width: 100%;text-align: center;font-size: 14px;height: 40px;padding:6px;margin-top:-10px"
                  size="medium" id="pcTag">
            工单号：{{ this.$route.query.orderNum }}&nbsp;&nbsp;&nbsp;&nbsp;
            工单到期时间：{{ this.$route.query.expirationTime }}&nbsp;&nbsp;&nbsp;&nbsp;
            工单类型：{{ this.$route.query.type }}&nbsp;&nbsp;&nbsp;&nbsp;
            工单名称：{{ this.$route.query.title }}&nbsp;&nbsp;&nbsp;&nbsp;
            工单状态：<span>{{ this.$route.query.status | formateStatus }}</span>
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
          <span style="display: none;">{{ this.$route.query.loginAccount }}</span>
          账号：
          <el-input placeholder="请输入账号" v-model="searchAccount" style="width: 200px;margin: 0px;padding: 0px;"></el-input>
          昵称：
          <el-input placeholder="请输昵称" v-model="searchNickName" style="width: 200px;margin: 0px;padding: 0px;"></el-input>
          用户类型：
          <el-select v-model="searchType" placeholder="请选择" style="width:100px">
            <el-option value="">全部</el-option>
            <el-option value="新粉">新粉</el-option>
            <el-option value="重粉">重粉</el-option>
          </el-select>
          时间：
          <el-date-picker v-model="searchDate" type="datetimerange" start-placeholder="开始日期" end-placeholder="结束日期"
                          :default-time="['00:00:00', '23:59:59']" value-format="yyyy-MM-dd HH:mm:ss"
                          format="yyyy-MM-dd HH:mm:ss"></el-date-picker>
          <el-button type="primary" style="margin-left: 5px" icon="el-icon-search" @click="loadOrderFans">搜索</el-button>
        </div>

        <div id="phoneSearch" style="display: none">
          <el-button icon="el-icon-arrow-left" @click="back" style="padding: 12px">返回</el-button>
          <span style="display: none;">{{ this.$route.query.orderNum }}</span>
          <span style="display: none;">{{ this.$route.query.loginAccount }}</span>

          <el-select v-model="value" clearable placeholder="请选择" style="width: 100px">
            <el-option
              v-for="item in options"
              :key="item.value"
              :label="item.label"
              :value="item.value">
            </el-option>
          </el-select>
          <el-input  clearable v-model="phoneSearch" style="width: 170px;margin: 0px;padding: 0px;"></el-input>
          <el-button type="primary" style="margin-left: 5px;margin-top: 10px" icon="el-icon-search" @click="loadPhoneOrderFans">搜索</el-button>
        </div>
      </el-header>
      <el-main style="padding-left: 0px;padding-top: 10px">
        <div>
          <el-table :data="orderFans" v-loading="tableLoading" border stripe style="width: 100%">
            <el-table-column prop="orderNum" align="center"  label="工单号" width="150px"></el-table-column>
            <el-table-column prop="headImg" align="center"  label="头像">
              <template slot-scope="scope">
                <el-image style="width: 50px; height: 50px; border-radius: 25px;"
                          :onerror="defaultImg" :src="scope.row.headImg ? scope.row.headImg : ''">
                </el-image>
              </template>
            </el-table-column>
            <el-table-column prop="account" align="center"  label="账户" width="200px"></el-table-column>
            <el-table-column prop="nickName" align="center"  label="昵称" width="150px"></el-table-column>
            <el-table-column prop="createTime" align="center" label="进粉时间" width="180px">
              <template slot-scope="scope">
                <el-link type="success" :underline="false">{{ scope.row.createTime | formatDateTime }}</el-link>
              </template>
            </el-table-column>
            <el-table-column prop="insertTime" align="center" label="记录时间" width="180px">
              <template slot-scope="scope">
                <el-link type="success" :underline="false">{{ scope.row.insertTime | formatDateTime }}</el-link>
              </template>
            </el-table-column>
            <el-table-column prop="type" align="center"  label="类型" :formatter="formateType" width="80px"></el-table-column>
            <el-table-column prop="repeatAccount" align="center"  label="重粉账号" width="120px"></el-table-column>
            <el-table-column prop="country" align="center"  label="国家"></el-table-column>
          </el-table>
          <div style="display: flex;justify-content: space-between;margin: 2px">
            <div class="block">
              <el-pagination @size-change="handleSizeChange" @current-change="currentChange" :current-page="currentPage" :page-sizes="[10, 20, 50, 100]" v-if="pcColumn"
                             :page-size="rows" layout="total, sizes, prev, pager, next, jumper"
                             :total="totalCount">
              </el-pagination>

              <el-pagination @size-change="handleSizeChange" @current-change="currentChange" :current-page="currentPage" :page-sizes="[10, 20, 50, 100]" v-if="phoneColumn"
                             :page-size="rows" layout="total, sizes, prev, pager, next"
                             :total="totalCount">
              </el-pagination>
            </div>
          </div>
        </div>
      </el-main>
    </el-container>
  </div>
</template>
<script>
export default {
  data() {
    return {
      options: [{
        value: 'searchLoginAccount',
        label: '账户'
      },{
        value: 'searchNickName',
        label: '昵称'
      }],
      value: 'searchLoginAccount',
      orderFans: [],
      phoneSearch: '',
      pcColumn: true,
      phoneColumn: false,
      showInfoTag: true,
      searchOrderNum: this.$route.query.orderNum,
      zeroTime: this.$route.query.zeroTime,
      searchDate: '',
      searchAccount: '',
      searchLoginAccount: this.$route.query.loginAccount,
      searchNickName: '',
      tableLoading: false,
      searchType: '',
      totalCount: -1,
      currentPage: 1,
      rows: 10,
      defaultImg: 'this.src="' + require('@/assets/default.png') + '"'
    };
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
  mounted: function () {
    this.loadOrderFans();
    this.isPc();
  },
  methods: {
    back() {
      this.$router.go(-1);//返回上一层
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
    hideInfo(){
      this.showInfoTag = false;
    },
    exportOrderFans() {
      let beginTime = "";
      let endTime = "";
      if (this.searchDate.length > 0) {
        beginTime = this.searchDate[0];
        endTime = this.searchDate[1];
      }
      window.open("/apis/export/orderFansExport?orderNum=" + this.searchOrderNum + "&account=" + this.searchAccount + "&loginAccount=" + this.searchLoginAccount + "&type=" + this.searchType + "&nickName=" + this.searchNickName + "&beginTime=" + beginTime + "&endTime=" + endTime + "", "_parent");
    },
    currentChange(currentChange) {
      this.currentPage = currentChange;
      this.loadOrderFans();
    },
    handleSizeChange(val) {
      this.rows = val;
    },
    formateType(row) {
      if (row.type === "底粉") {
        return this.$createElement('el-tag', { props: { type: 'success' } }, '底粉');
      } else if (row.type === "新粉") {
        return this.$createElement('el-tag', { props: { type: 'danger' } }, '新粉');
      } else if (row.type === "重粉") {
        return this.$createElement('el-tag', { props: { type: 'warning' } }, '重粉');
      } else if (row.type === "补录") {
        return this.$createElement('el-tag', { props: { type: 'info' } }, '补录');
      }
    },
    loadOrderFans() {
      let beginTime = "";
      let endTime = "";
      if (this.searchDate.length > 0) {
        beginTime = this.searchDate[0];
        endTime = this.searchDate[1];
      }
      this.tableLoading = true;
      this.postRequest("/orderDetails/getOrderFans", {
        "page": this.currentPage,
        "rows": this.rows,
        "orderNum": this.searchOrderNum,
        "account": this.searchAccount,
        "loginAccount": this.searchLoginAccount,
        "type": this.searchType,
        "nickName": this.searchNickName,
        "beginTime": beginTime,
        "endTime": endTime
      }).then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          let data = resp.data;
          this.orderFans = data.rows;
          this.totalCount = data.total;
        }
      })

    },
    loadPhoneOrderFans() {
      this.tableLoading = true;
      if(this.value === "searchLoginAccount"){
        this.searchAccount = this.phoneSearch;
        this.searchNickname = "";
      }else if(this.value === "searchNickName"){
        this.searchNickname = this.phoneSearch;
        this.searchAccount = "";
      }

      this.postRequest("/orderDetails/getOrderFans", {
        "page": this.currentPage,
        "rows": this.rows,
        "orderNum": this.searchOrderNum,
        "account": this.searchAccount,
        "loginAccount": this.searchLoginAccount,
        "nickName": this.searchNickName
      }).then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          let data = resp.data;
          this.orderFans = data.rows;
          this.totalCount = data.total;
        }
      })
    },
  }
};
</script>
<style>

@media screen and (max-width: 500px){
  #phoneTag, #phoneSearch {
    display: block !important;
  }
  #pcTag, #pcSearch{
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
</style>
