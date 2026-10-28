# REBUILD-03 追加架构补强验证（2026-10-28）

- 基线：28bfa70；实现：cfa012060dfcc110ae065f3fe01244d312a75d1d；分支 codex/assistant-rebuild。
- 范围：[R03-A1～A3](../issues/03-durable-execution-confirmations-and-budget.md)、[Spec职责及入口](../spec.md#runtime-responsibilities)。原范围证据保留，不追认新的实模/CU通过。
- 只在独立 formal_session_* / formal_execution_* 合成测试库及对象中运行；使用现有Node24/锁定SDK与受控HTTP模型。外部模型请求0，未创建或重开真实活动，未更新4240/4217或正式环境。

## 实现与证据

| 追加AC | 实现与实际验证 |
| --- | --- |
| R03-A1 | 新 SessionDispatcher 负责定时扫描、唤醒和启动/关闭；同一实例start幂等，重叠扫描复用同一Promise。ExecutionStore仍为租约/令牌/状态/预算/确认权威，pending候选也从其读取。宿主只协调执行，跟踪包括领取中的全部工作；关闭幂等，拒绝新领取，迟到领取中止且不发模型请求，等待在途工作后才关闭检查点连接。单元覆盖recover/wake/pending三个扫描关闭点，真实数据库覆盖关闭后的领取及领取中关闭。 |
| R03-A2 | 公开HTTP先受理pending消息，再新建真正 buildApp 默认派发的服务并 ready，由onReady启动自动扫描，经真实SDK读取项目并调用真实集合服务。断言唯一集合、一份material_receipt、稳定operation_key及原turn_id和公开页面投影；无直接runPending救场。第二派发器竞争及过期租约恢复仍使用原领取/令牌合同，合成旧预算保持。 |
| R03-A3 | 各扫描/唤醒/确认恢复沿用 FORMAL_RUNTIME_VERSION。真实入口覆盖v2 pending/waiting/confirmation与v1 paused，前后完整记录、确认及预算不变；当前版本正常执行。既有真实在途暂停、只读查询、超时后继续、纠错暂停恢复及唯一采用回执回归保持。扫描错误记录固定阶段/可信错误码；执行错误只记录真实任务身份与安全错误分类，不输出原始message/stack/正文/key。 |

服务端 onClose 先停止派发并等待当前扫描，再关闭/中止执行宿主；不另建队列、确认、计量或业务状态机。没有迁表、变更模型连接或改人工页面行为。

## 验证过程与结果

封装复用 ../r02-verification/run-directed.py，读取隔离开发连接但不输出凭据。各轮自建唯一测试库并在结束清理；下面不同运行有重叠，不相加为独立测试数。

| 运行 | 结果 / 本目录日志 |
| --- | --- |
| 旧实现 -t 'R03-A rejects' | 1失败、87跳过：关闭宿主后仍尝试领取，未以runtime_host_closed拒绝。red.log |
| 首轮定向10项 | 9通过、1夹具失败；改为真实buildApp后漏改旧workerDispatch清理引用及两处dispatch类型引用，已修，未放宽断言。first-green.log |
| 受影响3文件整体自动回归 | 167通过、8项页面启动失败，90.05秒；原因均为浏览器缺libatk动态库，非业务断言失败。core.log |
| 关闭竞争/扫描生命周期补验 | 6通过、87筛选跳过，7.29秒；包含新增真实领取中关闭。races.log |
| 上述8项页面补验 | 复用现有 /tmp/evalbase-r04-browser-libs 的LD_LIBRARY_PATH及FONTCONFIG_FILE，8通过、81筛选跳过，21.32秒。只补失败项，无系统安装/产品代码救场。browser.log |
| P2日志修复后单元 | 4通过，脱敏与阶段断言通过；log.log |
| typescript --noEmit、受影响7文件eslint、git diff HEAD/cached --check | 最终通过；types.log、lint.log及提交前检查。 |

按最新文件去重覆盖：rebuild-session 83项、rebuild-execution 89项、rebuild-dispatcher 4项，共176项，分轮验证；不称一次整轮全绿。新增领取中关闭及日志修复后只补直接受影响项，其他输入未变的证据沿用。浏览器为Playwright自动化回归，不是Computer Use或C01/C02重测。

## 复审、数据与后续

- Standards：完整基线差异只读复审无可行动问题，P0/P1为0。
- Spec：无P0/P1；P2要求后台扫描记录安全故障阶段，已补recover_confirmations/wake/pending及可信码，4项单元/lint通过，针对性复核确认关闭，无新增问题。
- 原验收库/旧会话/旧活动上限、已耗及关闭时间不在测试写入范围；公开入口另核对合成历史和预算哨兵保持。未运行C01/C02、未使用外部模型、未改现有环境或推送。
- 追加AC闭合后03恢复completed/targeted-pass；05原生CSV映射/确认缺口仍保留，下一步收口05并推进08，然后06→07/09→10。docs:check通过；本次3份Markdown的57处相对链接/锚点、表格/围栏及10票状态/依赖核对均通过。
