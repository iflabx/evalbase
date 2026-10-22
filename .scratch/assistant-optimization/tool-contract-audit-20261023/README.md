# 全工具参数传递审查证据

- 文档审查基线：a4102b78545eaf11d1e8b782b127330c662ab43d；业务基线：2c74b8e23d2b80770fd039f244da38d34f03f3b2。
- [审查报告](../../../docs/assistant-tool-parameter-review-2026-10-23.md)记录已确认问题、风险与反证；[字段表](field-matrix.md)逐项覆盖15工具/90顶层字段，列出399条含复用的字段路径。
- [tool-schemas.json](tool-schemas.json)：从真实businessTool参数和plan.steps/deliveries派生代码抽取的固定执行Schema、模型初始required及嵌套字段。动态规划投影的差异在报告§2记录；这不是线上每轮实际出站包的录制，不宣称已测试所有动态上下文。
- [probes.mjs](probes.mjs)用TypeScript AST抽取当前纯函数，在独立VM中运行固定输入；没有加载应用、数据库、Worker或模型连接。AJV只验证抽取Schema。候选seed探针注入选择器观察参数是否转发，未模拟随机分布、数据库或重启；P01是人工旧合同风险，N01是反证。
- [probe-results.json](probe-results.json)含14条观察结果及实际读取源码SHA256。14条均满足描述当前行为的探针断言；**不是14项修复/端到端测试通过**。探针首次因审查脚本换行转义错误未启动，修正审查脚本后运行成功；未修改业务文件。

复核时使用本次业务源码快照，现有依赖即可；在仓库根目录：

~~~sh
node .scratch/assistant-optimization/tool-contract-audit-20261023/probes.mjs . .
~~~

该脚本只读取指定源码和依赖并写本目录probe-results.json；不启动服务或访问网络。源码升级后不能把结果继续标为本基线，应另存证据并核对记录中的SHA256。无需重跑旧CU、生成、采用或预算任务。

现有确认、权限、字段保护、幂等回执机制逐项区分；未发现新增问题的工具仍须随受影响路径做开发期受控验证。基线、源码行号及未来AC对应关系在报告/票据维护，不另复制一份产品规范。
