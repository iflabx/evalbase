# REBUILD-05 原生CSV上传映射补验（2026-10-28）

后续决定：Owner明确不再补验、直接通过；该缺口已按[Owner豁免记录](../r05-owner-acceptance-20261028.md)关闭。下面的blocked、未上传及0请求为当轮实际结果，保持原样；不据豁免改写测试结果。

- 本次目标仅为R05-2尚缺的原生选择→映射预览→取消→确认/刷新证据，已通过的C03集合/移动/选择/背景链未重跑。
- 结果：blocked / 未完成。Implementation保持in-progress，Validation保持partial-pass；R05-2未勾选，不能据此关闭整票。
- 服务器分支codex/assistant-rebuild，HEAD d4b3e6c；既有4240预览未重建。操控为GPT-6.1 Terra high，复用已登录合成验收项目project_776c4cdee030445b9b085c007de3fac7，不发助手提示。

## 实际步骤及阻断

1. 准备本机3行非标准列名CSV，列为用户问法/标准回复/问题分类/适用渠道；首条问题有首尾空格，第二条渠道空值。文件SHA256为5671f4c1ae20af6238e72fd6885f23c00bc74156ecd263b9fae73e830d48810d。
2. 由现有助手“上传原始数据”原生入口打开第一步，使用按钮与实际input各一次filechooser等待，均10秒超时。新标签使用同一登录，未触及其他服务页面；界面始终未选文件、下一步禁用。
3. 按工具文档尝试原生窗口恢复。首次getApp约85.7秒后指出目标Chrome已最小化；随后只恢复该窗口为normal/focused，不改权限、安全设置或窗口尺寸配置。
4. 恢复后原生窗口操控因无法可靠确定当前浏览器网址而被工具安全检查终止。遵从停止要求，未继续电脑输入，也未用后端接口或脚本预填替代原生证据。
5. 本次无用户代选、无实际CSV上传、无映射/取消/确认/刷新证据。不能宣称全自动上传通过。

本机文件：D:/AgentBench_v2/.scratch/assistant-rebuild/implementation-20261027/r05-upload-gap/R05-上传映射补验-20261028.csv
阻断截图：D:/AgentBench_v2/.scratch/assistant-rebuild/implementation-20261027/r05-upload-gap/upload-chooser-blocked.jpg

## 数据及预算审计

通过独立只读脚本在既有evalbase_r04_20261028库采集18表原行的主键与内容hash，包含原16张助手/成果/账本保护表及data_asset、parsed_view。补验前后共981条既有行均未改变；仅保存hash，不在报告打印凭据或旧正文。

- assistant_runtime_request、activity的旧行与关闭时间保持；无新真实活动，无模型请求（0）、处理/生成（0）。
- 该CSV对应data_asset及pending_upload均为0；未形成待确认或已入库文件。
- 无项目业务代码/配置、运行环境、合并或推送变更。只新增本次合成材料、只读审计和证据。
- 原始审计：同目录before.json、after.json、audit.ts（原始文件留工作区，不纳入产品源码）；执行日志在r04-verification/r05-upload-gap-before.log及r05-upload-gap-after.log。

## 续接

需要恢复可用的文件选择入口后，从本次CSV的原生选择继续，实际观察映射和确认；若由Owner先选择文件，只能明确记录人工辅助，不宣称全自动选择。仍使用0模型调用的原生流程，不重开旧预算或重跑C03其余已通过部分。其余未关闭AC按原证据核对，不因此次阻断改判失败或通过。
