# Formal Schema dialect 与兼容性 seam

- Status: Accepted
- Date: 2026-08-31
- Decision role: Project Owner / Sole Developer

Formal Schema 固定使用 JSON Schema Draft 2020-12 的 Phase 1A 受支持子集，由独立 Formal Schema 深模块和专用 Ajv 2020 validator 负责生成、冻结、实例校验和兼容性判断。Fastify 路由 Schema 只校验 HTTP envelope，不能注册或解释 Formal Schema。

受支持子集必须限制 Schema 大小、深度、属性/关键字和正则风险，禁止远程 `$ref` 与校验时网络/数据库访问。破坏性变化返回 `requires_new_test_set` 且调用者不可覆盖；模式与输入/期望输出 schema 随版本冻结，业务 `metadata` 不参与测试集兼容性判断。

冻结 v5.2 原型把用户可见结构固定为问题、期望输出和 Metadata。Formal Schema 继续作为服务端安全编码、存储和序列化的内部机制，但不是用户确认、选择模式或任意编辑的日常 UI 步骤；保留历史模式的内部兼容能力不等于当前前端提供对应选项。原型中的“问题未填写、完全重复、来源已记录”等数据核对必须保持为警告，不得因 Formal Schema 或兼容逻辑变成隐藏阻断。

实施细节见 [Phase 1A 架构](../architecture/phase1a-architecture.md#55-solo-test-set-editor)和[数据与版本不变量](../architecture/phase1a-architecture.md#6-数据与版本不变量)。
