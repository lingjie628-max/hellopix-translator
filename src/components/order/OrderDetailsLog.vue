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
          </el-tag>
        </div>
        <div>
          <el-button icon="el-icon-arrow-left" @click="back">返回</el-button>
          <span style="display: none;">{{ this.$route.query.orderNum }}</span>
          <span id="pcSearch">
            时间：
            <el-date-picker v-model="searchDate" type="datetimerange" start-placeholder="开始日期" end-placeholder="结束日期"
                            :default-time="['00:00:00', '23:59:59']" value-format="yyyy-MM-dd HH:mm:ss"
                            format="yyyy-MM-dd HH:mm:ss"></el-date-picker>
            <el-button type="primary" style="margin-left: 5px" icon="el-icon-search" @click="loadOrderDetailsLog">搜索</el-button>
          </span>
        </div>
        <div style="margin-top:10px;">
          <el-button type="success" @click="exportOrderDetailsLog">
            <i class="fa fa-lg fa-level-down" style="margin-right: 5px"></i>导出数据
          </el-button>
        </div>
      </el-header>
      <el-main style="padding-left: 0px;padding-top: 10px">
        <div>
          <el-table :data="orderTarget" v-loading="tableLoading" border stripe style="width: 100%">
            <el-table-column prop="orderNum" align="center"  label="工单号" width="180px"></el-table-column>
            <el-table-column prop="wsid" align="center"  label="端口号" width="300px"></el-table-column>
            <el-table-column prop="insertTime" align="center"  label="日期" width="220px">
              <template slot-scope="scope">
                <el-link type="success" :underline="false">{{ scope.row.insertTime | formatDateTime }}</el-link>
              </template>
            </el-table-column>
            <el-table-column prop="account" align="center" label="账户" width="300px"></el-table-column>
            <el-table-column prop="nickName" align="center" label="昵称"></el-table-column>
            <el-table-column prop="completedDayTarget" align="center" label="单日已完成"></el-table-column>
            <el-table-column prop="completedTotalTarget" align="center" label="总完成"></el-table-column>
            <el-table-column prop="repeatQuantity" align="center" label="重粉数"></el-table-column>
            <el-table-column prop="dayTarget" align="center" label="单日目标"></el-table-column>
            <el-table-column prop="totalTarget" align="center" label="总目标"></el-table-column>
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
      orderTarget: [],
      searchOrderNum: this.$route.query.orderNum,
      searchDate: '',
      tableLoading: false,
      totalCount: -1,
      currentPage: 1,
      pcColumn: true,
      showInfoTag: true,
      phoneColumn: false,
      rows: 10,
    };
  },
  filters: {
    formateStatus(data) {
      if (data === '1') {
        return "正常";
      } else if (data === '2') {
        return "关闭"
      } else if (data === '3') {
        return "过期"
      } else if (data === '4') {
        return "删除"
      }
    }
  },
  mounted: function () {
    this.loadOrderDetailsLog();
    this.isPc();
  },
  methods: {
    back() {
      this.$router.go(-1);//返回上一层
    },
    hideInfo(){
      this.showInfoTag = false;
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
    currentChange(currentChange) {
      this.currentPage = currentChange;
      this.loadLoginLog();
    },
    handleSizeChange(val) {
      this.rows = val;
    },
    exportOrderDetailsLog() {
      var beginTime = "";
      var endTime = "";
      if (this.searchDate.length > 0) {
        beginTime = this.searchDate[0];
        endTime = this.searchDate[1];
      }
      window.open("/apis/export2/orderDetailLogExport?orderNum=" + this.searchOrderNum + "&wsid=" + this.$route.query.wsid + "&beginTime=" + beginTime + "&endTime=" + endTime + "", "_parent");
    },
    loadOrderDetailsLog() {
      var beginTime = "";
      var endTime = "";
      if (this.searchDate.length > 0) {
        beginTime = this.searchDate[0];
        endTime = this.searchDate[1];
      }
      this.tableLoading = true;

      this.postRequest("/orderTarget/getOrderTarget",
        {
          page: this.currentPage,
          rows: this.rows,
          orderNum: this.$route.query.orderNum,
          beginTime: beginTime,
          wsid: this.$route.query.wsid,
          endTime: endTime
        }
      ).then(resp => {
        this.tableLoading = false;

        if (resp && resp.status == 200) {

          this.orderTarget = resp.data.rows;
          this.totalCount = resp.data.total;
        }
      })
    },


  }
};
</script>
<style>
@media screen and (max-width: 500px){
  #phoneTag{
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
