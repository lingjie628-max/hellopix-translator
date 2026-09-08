<template>
  <div>
	  <el-header style="text-align: left;height: auto; padding: 0;">
	      <div>
          <el-row>
              <el-col><div class="grid-content bg-purple"></div>
              关键词：<el-input placeholder="请输入关键词" clearable v-model="searchKeyword" style="width: 180px;margin: 0px;padding: 0px;"></el-input>
                    <el-button type="primary" style="margin-left: 5px" icon="el-icon-search" @click="searchAssistantDetails">搜索</el-button>
              </el-col>
          </el-row>
	      </div>
	    </el-header>
    <el-container style="height: auto; border: 1px solid #eee;margin-top:10px">
      <el-aside  style="background-color: rgb(238, 241, 246);width: 100%" >
		<div style="background-color: rgb(238, 241, 246);height: 40px;">
			<div style="padding:10px">
				<span style="float:left">分组</span>
				<span style="float:right;padding-top:3px;cursor: pointer;"><i class="el-icon-plus" @click="showAssistantGroup(true)"></i></span>
			</div>
		</div>
        <el-menu default-active="1-0">
		  <el-menu-item v-for="(item,index) in assistantGroupValue"  @click="loadAssistantGroupDetails(item.id)" :default-active="'1-' + index" :index="'1-'+ index" :key="index">
			<span style="float:left">
				<i class="el-icon-folder-opened"></i>
				<span>{{item.title}}</span>
			</span>
			<span style="float:right">
				<i class="el-icon-edit" style="cursor: pointer;" @click="editAssistantGroup(item.id)"></i>
				<i class="el-icon-delete" style="cursor: pointer;" @click="deleteAssistantGroup(item.id)"></i>
			</span>
		  </el-menu-item>
        </el-menu>
      </el-aside>
    </el-container>
    <div style="margin-top: 20px">
      <el-rows>
        <el-col>
          <el-button type="success" icon="el-icon-plus" @click="showAddAssistantView(true)" :disabled="addDetailFlag">添加话术</el-button>
          <el-button type="warning" plain :disabled="deleteBtnFlag" icon="el-icon-delete-solid" @click="deleteAssistantDetails">批量删除</el-button>
        </el-col>
      </el-rows>
    </div>
    <el-main style="margin-top: 20px">
      <el-table :data="assistantDetailsValue" @selection-change="handleSelectionChange">
        <el-table-column type="selection" align="center" width="30"></el-table-column>
        <el-table-column prop="keyword" align="center" label="关键词"></el-table-column>
        <el-table-column prop="source"  align="center" label="原文内容" ></el-table-column>
        <el-table-column prop="target"  align="center" label="发送译文"></el-table-column>
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
    </el-main>
	<el-form ref="assistantDetailsForm" style="margin: 0px;padding: 0px;" :model="assistantDetail" :rules="assistantDetailsRules">
	  <div style="text-align: left">
		<el-dialog title="添加聊天翻译话术" style="padding: 0px;" :close-on-click-modal="false" :visible.sync="assistantDetailsDialogVisible" width="420px">
			<el-row>
				<el-col>
				  <div>
					<el-form-item label=" 关 键 词: " prop="keyword">
						<div>
							<el-input type="text" placeholder="请输入关键词" v-model="assistantDetail.keyword" maxlength="20" show-word-limit style="width:280px"/>
						</div>
					</el-form-item>
				  </div>
				</el-col>
			</el-row>
			<el-row>
				<el-col>
				  <div>
					 <el-form-item label="原文内容:" prop="source">
						 <div>
						 	<el-input  type="textarea"  placeholder="请输入原文" v-model="assistantDetail.source"  maxlength="255"  show-word-limit style="width:280px"></el-input>
						 </div>
					 </el-form-item>
				  </div>
				</el-col>
			</el-row>
			<el-row>
				<el-col>
				  <div>
					 <el-form-item label="发送译文:" prop="target">
						<div>
						 	<el-input  type="textarea" placeholder="请输入发送译文" v-model="assistantDetail.target"  maxlength="255"  show-word-limit style="width:280px"></el-input>
						 </div>
					 </el-form-item>
				  </div>
				</el-col>
			</el-row>
			<span slot="footer" class="dialog-footer">
				<el-button  @click="showAddAssistantView(false)">取 消</el-button>
				<el-button  type="primary" @click="saveAssistantDetails('assistantDetailsForm')">确 定</el-button>
			</span>
		</el-dialog>
	  </div>
	</el-form>

	<el-form ref="assistantGroupForm" style="margin: 0px;padding: 0px;" :model="assistantGroup" :rules="assistantGroupRules">
	  <div style="text-align: left">
		<el-dialog :title="assistantGroupTitle" style="padding: 0px;" :close-on-click-modal="false" :visible.sync="assistantGroupDialogVisible" width="420px">
			<el-row>
				<el-col>
				  <div>
					<el-form-item label="组名:" prop="title">
						<div>
							<el-input type="text" placeholder="请输入组名" v-model="assistantGroup.title" maxlength="20" show-word-limit style="width:300px"/>
						</div>
					</el-form-item>
				  </div>
				</el-col>
			</el-row>
			<span slot="footer" class="dialog-footer">
				<el-button  @click="showAssistantGroup(false)">取 消</el-button>
				<el-button  type="primary" @click="saveAssistantGroup('assistantGroupForm')">确 定</el-button>
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
		assistantGroupValue:[],
		assistantDetailsValue:[],
		searchKeyword:'',
		deleteBtnFlag: true,
    addDetailFlag: true,
		assistantDetailsDialogVisible:false,
		assistantGroupDialogVisible:false,
		assistantGroupOperates:'add',
		assistantOperates:'add',
		assistantGroupTitle:'',
    pcColumn: true,
    phoneColumn: false,
		ids:'',
		totalCount: 0,
		currentPage: 1,
		assistantGroupId:'',
		rows: 10,
		assistantDetail:{
			source:'',
			target:'',
			keyword:'',
			groupid:''
		},
		assistantGroup:{
			title:'',
			id:''
		},
		assistantDetailsRules: {
		  keyword: [{required: true, message: '请输入关键词', trigger: 'blur'}],
		  source: [{required: true, message: '请选择原文内容', trigger: 'blur'}],
		  target: [{required: true, message: '请输入发送译文', trigger: 'blur'}]
		},
		assistantGroupRules:{
			title: [{required: true, message: '请输入组名', trigger: 'blur'}]
		}
      };
    },
    mounted: function () {
		  this.loadAssistantGroup();
      this.isPc();
    },
    methods: {
	   loadAssistantGroup(){
		   this.getRequest("/assistant/getAssistantGroup").then(resp=> {
		   if (resp && resp.status == 200) {
		       var data = resp.data;
		       this.assistantGroupValue = data;
           if(data.length > 0){
             this.loadAssistantGroupDetails(this.assistantGroupValue[0].id);
             this.addDetailFlag = false;
           }else{
             this.addDetailFlag = true;
           }
		     }
		   })
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
	   searchAssistantDetails(){
		   this.loadAssistantGroupDetails(this.assistantGroupId);
	   },
     handleSizeChange(val) {
        this.rows = val;
     },
	   loadAssistantGroupDetails(value){
		   this.assistantGroupId = value;
		   this.postRequest("/assistant/getAssistantDetails",{groupid:value, keyword: this.searchKeyword, rows: this.rows, page: this.currentPage}).then(resp=> {
		   if (resp && resp.status == 200) {
		       var data = resp.data;
		       this.assistantDetailsValue = data.rows;
			     this.totalCount = data.total;
		     }
		   })
	   },
	   currentChange(currentChange){
	     this.currentPage = currentChange;
		 this.loadAssistantGroupDetails(this.assistantGroupId);
	   },
	   handleSelectionChange(selection) {
	      if(selection.length > 0){
	   	  var idsVal = '';
	   	  for(var i=0; i<selection.length; i++){
	   		  idsVal += selection[i].id + ",";
	   	  }
	   	  this.ids = idsVal.substring(0, idsVal.length - 1);
	   	  this.deleteBtnFlag = false;
	     }else{
	   	  this.deleteBtnFlag = true;
	     }
	   },
	   deleteAssistantDetails(){
		   this.$confirm('是否要批量删除此话术?', '提示', {
		     confirmButtonText: '确定',
		     cancelButtonText: '取消',
		     type: 'warning'
		   }).then(() => {
		      this.postRequest("/assistant/deleteAssistantDetails", {ids: this.ids}).then(resp=> {
		      if (resp && resp.status == 200) {
		          var data = resp.data;
		          this.$message({type: data.success, message: data.msg});
		   		    this.loadAssistantGroupDetails(this.assistantGroupId);
		        }
		      })
		   }).catch(() => {
		   });
	   },
	   deleteAssistantGroup(value){
       this.$confirm('是否要删除此分组?', '提示', {
         confirmButtonText: '确定',
         cancelButtonText: '取消',
         type: 'warning'
       }).then(() => {
          this.postRequest("/assistant/deleteAssistantGroup", { id: value }).then(resp=> {
          if (resp && resp.status == 200) {
              var data = resp.data;
              this.$message({type: data.success, message: data.msg});
              this.loadAssistantGroup();
              this.loadAssistantGroupDetails(this.assistantGroupId);
            }
          })
       }).catch(() => {
       });
	   },
	   showAddAssistantView(value){
		   this.assistantDetailsDialogVisible = value;
	   },
	   showAssistantGroup(value){
		   this.assistantGroupTitle='添加分组';
		   this.assistantGroupOperates = 'add';
		   this.assistantGroupDialogVisible = value;
	   },
	   editAssistantGroup(id){
		   this.assistantGroupTitle='修改分组';
		   this.assistantGroupOperates = 'edit';
		   this.getRequest("/assistant/selectAssistantGroupById?id="+ id +"").then(resp=> {
		   if (resp && resp.status == 200) {
		       var data = resp.data;
		       this.assistantGroup = data;
		     }
		   })
		   this.assistantGroupDialogVisible = true;
	   },
	   saveAssistantDetails(formName){
		   this.$refs[formName].validate((valid) => {
		     if (valid) {
		         //添加
		         this.assistantDetail.groupid = this.assistantGroupId;
		         this.postRequest("/assistant/editAssistant?assistantOperates="+ this.assistantOperates +"",this.assistantDetail).then(resp=> {
		         if (resp && resp.status == 200) {
		             var data = resp.data;
		             this.$message({type: data.success, message: data.msg});
		             this.assistantDetailsDialogVisible = false;
		         	 this.$refs[formName].resetFields();
		             this.loadAssistantGroupDetails(this.assistantGroupId);
		           }
		         })
		     } else {
		       return false;
		     }
		   });
	   },
	   saveAssistantGroup(formName){
		  this.$refs[formName].validate((valid) => {
		    if (valid) {
		        //添加
		        this.postRequest("/assistant/editAssistantGroup?assistantGroupOperates="+ this.assistantGroupOperates +"", {title: this.assistantGroup.title, id:this.assistantGroup.id}).then(resp=> {
		          if (resp && resp.status == 200) {
		            var data = resp.data;
		            this.$message({type: data.success, message: data.msg});
					this.$refs[formName].resetFields();
					this.assistantGroupDialogVisible = false;
		            this.loadAssistantGroup();
		          }
		        })
		    } else {
		      return false;
		    }
		  });
	   }
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

  .el-menu-item *{
	  vertical-align:baseline;
  }

  .el-menu-item, .el-submenu__title{
	  line-height:43px !important;
  }
</style>
