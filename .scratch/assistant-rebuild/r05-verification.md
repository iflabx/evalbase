# REBUILD-05 验证记录

基线1524880；分支codex/assistant-rebuild。当前开发和定向验证进行中，C03尚未执行。保留既有验收数据和旧预算。

## 能力覆盖

| 编号 | 实际接入 |
|---|---|
| P01/P02/P03 | list_projects/create_project/read_project_access；共享MaterialsStore、服务端角色权限 |
| P04 | navigate_project受控导航，任务仍绑定原project |
| P05 | input-scope固定真实IDs/修订；真实页面选择及多文件source交接 |
| M01/M02/M03 | list_collections/create_collection/list_material_files |
| M04/M05 | read_material_raw 12KB有界原文；records分页搜索、record单条全文 |
| M06～M09 | open_material_upload及现有ConfirmedUploadDialog原生选择、映射预览、确认/取消/过期/防重 |
| M10 | open_material_mapping与MaterialPreparation初次映射 |
| M11/M12 | move_material_file共享移动服务；合法原有处理/助手入口 |
| A04 | 私有背景上传、目录、5片段分页读取和真实页行引用；5份合计10MB |

## 合同与安全

新增工具合同版本deepagents-v3；v1/v2只读保留，不唤醒旧检查点、不改旧预算。材料写入在事务内复检真实身份权限并记录持久操作回执；原页面复用同一领域服务。原生固定确认继续沿用现有API，不新增模型确认提交工具。背景不是原始记录；文档指令不授予权限。空选/失效范围拒绝，不回落整文件。明确新文件名可重新核对并覆盖旧页面对象。

## 定向验证

- 材料公开API/真实tool.invoke集成8项通过。
- 背景证据/合计容量7项通过。
- 共享回归104项中103通过，唯一失败为新增工具清单断言；更新为批准清单后单独通过。
- 新增真实SDK3项通过：页面A/明确B与创建移动，failed discovery→普通继续→明确B，旧v2只读及viewer背景上传拒绝。另真实SDK核对nativeAction投影通过。
- Standards复审发现选择生命周期P1和附件降权锁P2；锁已补，选择修复及前端受控页面回归待最终结果。

## C03预算与边界

新独立活动最多16实际请求，0处理行次/0生成，25分钟；计入第二批C03～06共享74请求/32行次/12生成/90分钟。旧活动不重开，不重置。只在隔离4240部署；不合并、不推送、不部署正式环境。完成真实Computer Use后补实际结果，不用受控模型测试冒充CU。

## 开发收口补充

R05新增真实SDK4项、原生action投影复验通过；旧v2的控制和额度入口均拒绝写入。编辑者在对象存储阶段被降权后，真实附件事务拒绝提交。前端types、10项单测和7项受控浏览器通过，选择loading/空态稳定挂载P1已关闭；工具中文名与合计容量提示已同步。查看权限背景上传UI对齐补验进行中。

开发最终检查：前后端类型通过；前端10单测和8受控浏览器场景通过。Standards/Spec两轴已针对最终差异复核，无剩余阻断。权限降级、选择生命周期、中文工具名和合计容量提示补修均已验证。C03仍待新活动执行。
