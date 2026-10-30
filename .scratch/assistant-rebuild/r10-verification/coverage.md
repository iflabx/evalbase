# REBUILD-10 能力与证据核对

本表核对当前85项能力的实际入口，不新增产品合同或宣称85项均已逐项Computer Use。来源为[权威能力清单](../../../docs/assistant-rebuild-capabilities.md)，运行语义见[重建架构](../../../docs/architecture/assistant-rebuild.md)。旧表中的“旧覆盖”是历史盘点，不能用作当前接入结论。

共享校验与参数合同复用各领域工具Schema、真实SDK/HTTP证据；权限、来源/修订、确认、防重和恢复不按按钮复制状态机。原生文件、凭据、冲突选择及必要确认明确保留原生步骤，不冒充全自动。

| 编号 | 能力 | 实际入口/协作 | 有效证据 | 验证口径/限制 |
| --- | --- | --- | --- | --- |
| P01 | 查询、搜索、分页查看可访问项目 | list_projects | [原票记录](../r05-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| P02 | 创建项目；名称、描述 | create_project | [原票记录](../r05-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| P03 | 查看当前项目和权限 | read_project_access | [原票记录](../r05-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| P04 | 切换项目、打开业务页面和设置 | navigate_project + 项目壳导航 | [原票记录](../r05-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| P05 | 将当前对象和勾选范围交给助手 | input-scope + 原生勾选/flush | [原票记录](../r05-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| M01 | 查询集合；名称、类型、内容状态、更新时间、分页 | list_collections | [原票记录](../r05-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| M02 | 创建原始数据集合；名称、描述 | create_collection | [原票记录](../r05-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| M03 | 查询集合文件和文件详情 | list_material_files | [原票记录](../r05-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| M04 | 查看原始文件内容预览 | read_material_raw | [原票记录](../r05-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| M05 | 浏览、搜索统一记录，查看单条全文，切换密度 | read_material_records / read_material_record + 原生行高 | [原票记录](../r05-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| M06 | 选本地文件并开始待确认上传 | open_material_upload + ConfirmedUploadDialog | [原票记录](../r05-verification.md) | API/共享服务证据；原生CSV页面补验由Owner豁免 |
| M07 | 配置问题、期望输出、Metadata 映射并预览 | 原生映射预览（文件不交模型） | [原票记录](../r05-verification.md) | API/共享服务证据；原生CSV页面补验由Owner豁免 |
| M08 | 确认上传：按映射保存或只存原件 | 原生上传固定确认（映射或只存原件） | [原票记录](../r05-verification.md) | API/共享服务证据；原生CSV页面补验由Owner豁免 |
| M09 | 取消未确认上传 | 原生取消未确认上传 | [原票记录](../r05-verification.md) | API/共享服务证据；原生CSV页面补验由Owner豁免 |
| M10 | 给已保存但未整理的文件补充映射 | open_material_mapping + MaterialPreparation | [原票记录](../r05-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| M11 | 移动文件到同项目另一集合 | move_material_file | [原票记录](../r05-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| M12 | 从文件进入处理或助手 | 原文件页处理入口/范围交接 | [原票记录](../r05-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| D01 | 搜索、全部/草稿/已发布筛选、分页 | list_test_sets | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| D02 | 创建新草稿 | create_draft | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| D03 | 基于正式版本创建/继续共享草稿 | create_draft(parentVersionId) / open_draft | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| D04 | 查看草稿、搜索分页、展开记录与来源 | read_draft / open_draft | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| D05 | 修改草稿名称、用途，离焦保存 | update_draft + 原生离焦队列 | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| D06 | 手动添加记录；问题、期望输出、Metadata 或真实来源 | add_draft_record | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| D07 | 编辑单条问题、期望输出、Metadata | update_draft_record | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| D08 | 删除草稿记录 | request_remove_record + 固定确认 | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| D09 | 冲突时取服务端值或保留输入；被删记录另存为新记录 | draft_conflict + open_draft原生冲突处理 | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| D10 | 退出/切换记录/分页前提交输入；失败重试 | 原生flush/失败保留输入 | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| D11 | 删除未发布草稿 | request_discard_draft + 固定确认 | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| D12 | 发布新测试集或派生版本 | request_publish + 固定确认 | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| D13 | 从草稿进入处理 | open_draft_processing | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| S01 | 搜索、选文件，本页/全部搜索结果/取消 | list_draft_source_files + 原生文件选择 | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| S02 | 条件筛选，全部匹配或随机数量/比例，生成预览 | preview_selection | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| S03 | 分页看预览、排除/补选、恢复初选、换一批 | read_selection_preview + 原生排除/补选/恢复/重抽 | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| S04 | 确认将所选记录加入草稿 | request_selection_apply + 固定确认 | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| S05 | 查看选取历史与已选来源 | read_selection_history | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| V01 | 版本图、版本切换、摘要 | read_version + 版本图 | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| V02 | 正式记录搜索分页、单条全文、Metadata | read_version_records | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| V03 | 来源、修改明细、选取历史、处理关联 | read_version_provenance | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| V04 | 下载 CSV，或数据与溯源 ZIP | download_version + 原生下载 | [原票记录](../r06-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| V05 | 整个测试集移入回收站 | request_trash_test_set | [原票记录](../r09-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| V06 | 末端版本或版本及后代分支移入回收站 | request_trash_version_branch | [原票记录](../r09-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| V07 | 删除中间版本内容、保留关系节点 | open_recycle_destructive_action + 原生输入版本号 | [原票记录](../r09-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| V08 | 看回收站、恢复条目 | list_recycle_bin / request_restore_test_set | [原票记录](../r09-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| V09 | 永久删除回收站条目 | open_recycle_destructive_action + 原生输入名称 | [原票记录](../r09-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| W01 | 任务列表、搜索、状态筛选、分页、刷新 | list_processing_tasks + 原生列表刷新 | [原票记录](../r07-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| W02 | 选文件/草稿/版本，搜索/Metadata 筛选，勾本页/全部匹配/只看已选 | preview_processing_round + 原生条件/真实结果ID | [原票记录](../r07-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| W03 | 清洗/改写/扩充；范围、要求、字段策略、Metadata 键、扩充数量 | create_requirements / update_requirements / submit_processing | [原票记录](../r07-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| W04 | 状态、当前成果、错误、数量/重复/空值/缺失/字段保护检查 | read_task_progress / read_processing_task | [原票记录](../r07-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| W05 | 结果搜索、只看变化/需核对/重复；全文、Metadata、来源和处理过程 | read_processing_task + 原生结果/来源详情 | [原票记录](../r07-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| W06 | 勾本页/全部匹配/改写未生效记录，清空选择 | read_processing_task返回真实allIds + 原生勾选 | [原票记录](../r07-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| W07 | 预览重复组、排除重复、恢复排除 | deduplicate_processing_task | [原票记录](../r07-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| W08 | 同一任务内继续处理当前所选未保存成果 | preview_processing_round / submit_processing_round(continue) | [原票记录](../r07-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| W09 | 沿上轮完整冻结输入重新处理 | submit_processing_round(rerun) | [原票记录](../r07-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| W10 | 历史轮次、历史要求/输入/结果 | read_processing_history | [原票记录](../r07-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| W11 | 取消运行、重试失败部分 | control_processing_run(cancel/retry) | [原票记录](../r07-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| W12 | 补齐未完成部分/实际缺额 | submit_processing_round(complete) | [原票记录](../r07-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| W13 | 保存回原草稿；清洗/改写更新对应行，扩充追加 | prepare_adoption / prepare_processing_task_save(原草稿) | [原票记录](../r07-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| W14 | 另存原始数据、新草稿或加入已有草稿 | prepare_processing_task_save(新草稿/已有草稿/原始数据) | [原票记录](../r07-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| W15 | 保存响应不明时核对回执、重试原操作 | 相同确认重放真实receipt | [原票记录](../r07-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| W16 | 基于已保存草稿继续处理 | submit_processing_round(saved) | [原票记录](../r07-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| A01 | 新建/搜索/分页/切换本人会话，查消息和状态 | 正式sessions分页/消息/SSE与原生会话列表 | [原票记录](../r04-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| A02 | 会话改名 | 正式PATCH会话（手动title优先） | [原票记录](../r04-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| A03 | 删除会话 | 正式DELETE会话 + HistoryStore清理 | [原票记录](../r08-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| A04 | 上传 PDF/MD/TXT 背景、看片段和引用 | 原生背景上传 + list_attachments/read_attachment | [原票记录](../r05-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| A05 | 删除背景文档 | 正式DELETE附件 + 依赖清理 | [原票记录](../r08-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| A06 | 普通提示查询、规划、改要求、执行；选择来源 | create_requirements/update_requirements + 领域工具 | [原票记录](../r03-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| A07 | 背景驱动从零生成、多交付、分类和数量要求 | generate处理合同 / 多交付稳定身份 | [原票记录](../r07-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| A08 | 整任务候选审核/筛选/勾选、局部改写、配额选取和精确去重 | read_processing_task/preview_processing_round + submit_processing_round局部处理 / deduplicate_processing_task / 真实结果ID采用；分类配额保留在classifications | [原票记录](../r07-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| A09 | 确认/拒绝选取、采用、发布提案 | 原生固定确认/拒绝，模型无approve | [原票记录](../r04-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| A10 | 暂停/停止、查询、继续、按方案执行、重试未完成步骤 | 高优先停止 / read_task_progress / continue_task / 失败部分重试 | [原票记录](../r04-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| A11 | 查历史任务、恢复指定任务 | HistoryStore历史读取/handoff；同运行时continue，不转换旧检查点 | [原票记录](../r08-verification.md) | 同运行时原任务恢复；跨运行时仅显式新预算handoff，旧检查点只读 |
| A12 | 查看额度、同意有上限继续/修复额度 | 原账本投影 + 服务端offer/用户确认追加 | [原票记录](../r03-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| A13 | 操作记录、诊断、产物链接、跳转工作区 | 持久事件/真实回执 + 动态工作区 | [原票记录](../r04-verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| U01 | 首次初始化、注册、登录 | 原生AccountGate初始化/注册/登录（非模型工具） | [原票记录](../r09-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| U02 | 查本人资料、改名称/头像颜色 | read_my_profile / update_my_profile | [原票记录](../r09-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| U03 | 登出 | open_sign_out + 原生登出 | [原票记录](../r09-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| U04 | 查邀请、接受邀请 | list_my_invitations / accept_my_invitation | [原票记录](../r09-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| U05 | 查项目成员 | list_project_members | [原票记录](../r09-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| U06 | 看邀请记录、邀请已注册用户 | list_project_invitations / request_project_invitation | [原票记录](../r09-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| U07 | 撤销邀请 | request_revoke_invitation | [原票记录](../r09-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| U08 | 修改成员角色 | request_member_role | [原票记录](../r09-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| U09 | 移除成员 | request_remove_member | [原票记录](../r09-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| U10 | 查项目可用模型名称和状态 | read_available_model | [原票记录](../r09-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| U11 | 管理员查/改模型连接、预设/自定义模型、端点、启停、换 key | read_model_settings / open_model_settings + 原生密钥与固定保存确认 | [原票记录](../r09-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |
| U12 | 测试已保存模型连接 | test_saved_model_connection（已保存修订/真实尝试计量） | [原票记录](../r09-verification/verification.md) | 源码接线＋原责任票分层证据，非逐编号CU |

## 必须保留的证据区别

- [CSV页面补验豁免](../r05-owner-acceptance-20261028.md)是Owner决定，不是实测通过；不重开C03或借用C07/C08补验。
- [C05记录](../r07-verification/verification.md)包括原场景规划→取消混合交付→3＋2保存，以及独立补验的选首条扩充2条保存；按分阶段累计通过记录，保留初次source_revision_conflict与用途旧文案，不回填旧数据。
- [C06记录](../r09-verification/verification.md)只将邀请、回收恢复、查看账号界面和隔离假连接列为CU通过；角色调整、越权HTTP与不可恢复删除输入边界使用受控SDK/HTTP证据。
- A08的当前入口支持任务结果读取、明确ID筛选/采用、分类与配额约束、局部加工和精确去重；不承诺新建独立语义检索、语义去重或无限自动质量审核。

## RB01～15 收口索引

| 合同 | 主要证据责任 | 本票补验 |
| --- | --- | --- |
| RB01 | R01中立提交、R02/03正式宿主，无旧planner/tasks导入 | 旧执行路由不注册、旧请求410、退役proof拒绝 |
| RB02 | 本表85项、R05额外集合/移动真实业务回执 | 引用闭合，豁免明确 |
| RB03 | R01/05/06/08/09权限与跨项目边界 | 沿用有效回归，停用不放宽人工权限 |
| RB04 | R04/05真实页面选择与flush，R06冲突 | 沿用有效证据 |
| RB05 | R02/04共享参数反馈与真实SDK，R07/09领域接线 | 摘要后真实SDK修改；不增加纠错器 |
| RB06 | R03/06操作、采用与发布回执重放 | 停用保留已提交回执，C07/C08唯一保存 |
| RB07 | R03持久等待、竞领、终态补查 | 预检普通/model Worker启动与代码身份 |
| RB08 | R03/04真实在途停止，跨轮恢复补修 | C08另一种表达、实际Worker在途停止/查询/继续 |
| RB09 | R03/06/09固定确认及原生输入 | 屏障阻止未确认写入，重新启用不复活旧卡 |
| RB10 | R02/03摘要、纠正、正文与Worker计量 | C07摘要同账，旧预算逐字段保护 |
| RB11 | R08旧历史、手动命名、显式handoff | 退役旧派发/确认令牌，历史GET零请求 |
| RB12 | R08及R07后续处理/背景依赖清理 | 未删除旧表、检查点、成果或预算 |
| RB13 | C01～C06分层记录及C05取消页面证据 | C07/C08普通提示与真实回执/名称/链接 |
| RB14 | R01人工上传→选取→清洗→采用→发布→下载 | 在旧派发退出的新代码上定向回归 |
| RB15 | 本票运行时模式与操作员规程 | 随机隔离库演练停用/重新启用；不降级、不双引擎回退 |

执行结果、固定版本和未关闭风险以[本票唯一记录](verification.md)为准。
