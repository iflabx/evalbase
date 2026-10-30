# REBUILD-10 依赖安全适用性与最小修复方案

日期：2026-10-30；基线 `7d738bb`，隔离应用 `f484d68`。这是源码/锁文件/已安装包和上游公告的只读评估，不是漏洞利用测试，不是生产渗透测试。没有升级依赖、发模型请求、修改业务数据或预算。

## 审查范围与结论

重新向npm官方registry审计当前两个锁文件：
- [根生产依赖](dependency-audit.json)：10个包级告警，8 high、2 moderate、0 critical，结果与原审计相同。
- [frontend-v3生产依赖树](frontend-audit.json)：4个high包。这里的“生产依赖树”仍包含被插件引入的Vite/PostCSS等构建工具，不能将4项一律当作浏览器或线上服务暴露。
- 另查实际预览Node：`v24.6.0`，内置Undici `7.13.0`；npm树中Undici为 `7.30.0`，是两份实现。主模型链 `src/assistant-rebuild/session-model.ts → src/model/connection.ts:modelFetch → global fetch` 使用前者；只升级npm依赖不会修复内置实现。
- 当前最应先处理的是**运行时网络栈及兼容补丁升级**。下文P1/P2是整改优先级，不表示已经验证可利用；当前没有发现被利用或数据泄露证据。
- 本次比原审计增加了前端锁、Node内置依赖及unpdf打包引擎核对。审计未覆盖生产镜像OS包、实际生产反向代理配置或全部传递包的许可证法律审查，不宣称生产安全评估完整。

上游公告原文通过GitHub官方Advisories API逐条核对；版本候选另查npm官方元数据。适用性是结合以下调用点作出的推断，未满足触发条件的项不应虚报成远程攻击已证实。

## 服务端10个包的逐项判定

| 包 / 当前版本 | 触发条件与本项目调用 | 判定 / 最小处理 |
| --- | --- | --- |
| fastify 5.12.0（high） | `src/server/app.ts` 建立HTTP/1服务，未启用数字trustProxy/HTTP2/trailer/异步路由Schema；唯一not-found处理只返回SPA壳或404，没有私有租户数据。公告中的这些特定前提未观察到；业务校验另走服务校验器。 | P2兼容修复优先：固定5.12.7。不能据公告标题断言现有登录已可绕过；升级后验证畸形URL fail-closed、未登录/越权、JSON体校验、静态页与SSE。 |
| fast-uri 4.1.2及Ajv嵌套3.1.5（high） | 由Fastify编译器/fast-json-stringify/Ajv引入。应用网络端点解析使用WHATWG URL；未见fast-uri承担远端地址授权。正式Schema限制大小/深度/关键字，无loadSchema/compileAsync远端抓取。 | P2：分别刷新到4.2.3和3.1.9或同主版本后续修复版；两份都检查。修复URI规范化，不引入远端Schema加载。 |
| undici npm 7.30.0（high） | 来自@ai-sdk/provider-utils，安全下载辅助内部引用npm Undici；主助手请求则走global fetch。过量content-encoding导致崩溃公告适用于此npm版本；未发现应用使用EventSource、WebSocket、共享cache/redirect interceptor或自定义tls pinning。 | 网络栈整改的一部分：锁7.30.1或7.x已修复版，避免无必要跨8.x。核对实际调用与内置版本，不把所有Undici公告都算主助手可触发。 |
| brace-expansion 5.0.9（high，位于glob嵌套目录） | @fastify/static→glob→minimatch；wildcard:false注册静态文件时使用固定 `**/**`，未将请求/聊天文本作为glob模式。根目录另一个1.1.18不是本告警命中路径。 | P2低暴露：刷新该嵌套包至5.0.12；不用1.x替换5.x，不误修根目录副本。验证静态文件枚举/首页。 |
| csv-parse 6.1.0（moderate） | `src/parser/csv.ts:92`列映射先拒绝重复表头；未启用group_columns_by_name。公告需要重复特殊表头及分组，当前组合不可达。 | P2：先保留明确不可达依据；若升级7.0.3，定向验证重复/特殊表头、编码、引号、映射和超限，不能因审计提示就静默跨主版本。 |
| pdfjs-dist 5.6.205（high） | 当前只提供CMap/字体资源；实际文本解析来自unpdf内置PDF.js 6.1.200。应用在限时/限内存Worker中只取文本、不载入浏览器viewer，无enableScripting路径；isEvalSupported:false是另一层限制，不能冒充公告中的enableScripting:false。 | P2：当前公告的浏览器脚本利用链未建立；必须同时处理资源包与实际内置引擎，不能仅升pdfjs-dist后宣称解析器已升级。方案见下文。 |
| minio 8.0.7（high聚合） | high来自query-string/decode和stream-json的传递告警，不是MinIO服务端漏洞结论。ArtifactRepository只调用对象读写/列表/统计/删除等，端点来自服务配置。 | P2兼容性待办。不要按audit建议倒退到7.1.3；该建议不能作为安全版本推荐。 |
| query-string 7.1.3（high聚合） | MinIO客户端已检查的调用均是qs.stringify；恶意解码链要求parse/decode，不是编码。 | 随MinIO一起处理，不额外换一个URL处理框架；保留当前未触发解码的代码证据。 |
| decode-uri-component 0.2.2（high） | 由query-string引入；当前MinIO路径未调用其恶意输入解码。 | 可评估局部override到0.5.1，但需确认CJS/导出与query-string兼容、受控恶意解码负例和对象存取；不能仅凭同为0.x假定兼容。 |
| stream-json 1.9.1（moderate） | MinIO的通知模块引用jsonl/Parser；应用无listenBucketNotification调用，也未调用公告涉及的过滤器、JSONC或Assembler路径。 | 当前未见可达路径。不要强制覆盖3.x（导出路径/API可能不兼容）；优先上游修复/有界回补，否则逐条记录暂缓理由，不借本轮替换整个对象存储。 |

主要上游依据：[Fastify异步Schema](https://github.com/fastify/fastify/security/advisories/GHSA-667r-xxjv-c9mm)、[Fastify not-found](https://github.com/advisories/GHSA-p68q-wchp-6fh7)、[fast-uri](https://github.com/fastify/fast-uri/security/advisories/GHSA-w74x-v6f9-j3xg)、[Undici响应编码](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c)、[brace-expansion](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)、[CSV](https://github.com/advisories/GHSA-8cw4-87c7-c6xx)、[PDF.js](https://github.com/mozilla/pdf.js/security/advisories/GHSA-hq66-cqwq-w95j)、[decode-uri-component](https://github.com/advisories/GHSA-qr28-fpjm-wq7f)、[stream-json](https://github.com/advisories/GHSA-mjw6-4jj6-33hc)。各包其余公告及受影响版本见原始审计，以上没有将聚合包重复计作独立攻击链。

## npm扫描外的运行时风险

**P1整改优先：预览仍使用Node24.6.0的内置Undici7.13.0。** 主助手、摘要、纠错等模型请求最终使用global fetch。上游[TLS1.2重协商崩溃公告](https://github.com/nodejs/undici/security/advisories/GHSA-qrxm-fqhp-jwvm)涵盖该版本：条件是所连接的HTTPS端点恶意或被攻陷，并进行特定证书切换；不是普通用户仅发提示词即可触发。代码限制重定向，但这不消除TLS连接层风险。本轮未连接恶意站点验证，也未声称已知模型端点存在攻击。

建议继续使用Node24受支持主线，候选[24.22.2 LTS](https://nodejs.org/en/blog/release/v24.22.2)，其[内置Undici元数据](https://github.com/nodejs/node/blob/v24.22.2/deps/undici/src/package.json)为7.30.1。同时更新构建、Web、ordinary/model Worker以及Docker各阶段的同一已验证镜像digest，部署后核对实际 `process.version/process.versions.undici`。当前Dockerfile固定digest的生产实跑Node版本没有在本轮检查，不能把预览24.6.0冒充正式环境版本。

验收只用受控HTTP/TLS端点：正常/流式响应、超时/取消、TLS失败仅返回请求错误、重定向拒绝、异常编码响应不会终止子进程；确认失败尝试仍计一次且已保存回执不重放。使用隔离子进程避免有缺陷版本拖垮预览。无须真实模型重跑成功业务。

## 前端补查4个包

| 包 / 锁定版本 | 实际暴露判断 | 修复方案 |
| --- | --- | --- |
| seroval 1.6.4（high） | TanStack router-core传递依赖；当前是SPA，没有发现自写SSR序列化/反序列化不可信节点入口，不能直接断言服务端RCE。 | 优先同主版本刷新到至少1.6.11（覆盖本次几项公告），核对路由状态/深链接/消息与工作区打开；不引入SSR。 |
| source-map-js 1.2.1（high） | Tailwind/PostCSS构建链；本项目不提供上传任意source map的线上解析服务。 | 升1.2.2；用受控恶意offset负例加前端构建验证。 |
| vite 8.2.2（high；根工具链另有8.2.1） | 当前4240由Fastify服务dist/web；Docker运行层不启动Vite。Windows editor和dev server公告不能直接等同生产漏洞；开发服务器暴露仍需处理。 | 两份锁刷新到8.2.4或同主线已修复版本；保留SPA配置/loopback开发边界，验证构建与代理，不跨主版本。 |
| zod 3.25.76及router插件嵌套4.5.4（high） | 前端表单/构建依赖树；应用后端正式工具已用4.6.7。未发现前端源码直接import zod，插件4.x仍需修复。 | 4.x嵌套刷新4.6.7；对3.x先确认未使用后移除直接依赖，若实际调用则做有范围的4.x迁移及表单错误回归，不将全树强制override到4.x。 |

上游依据：[Seroval typed-array](https://github.com/lxsmnsyc/seroval/security/advisories/GHSA-f86p-h4j2-7qgj)、[Seroval RegExp](https://github.com/advisories/GHSA-9wx9-5pv9-3349)、[source-map-js](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)、[Vite开发服务](https://github.com/advisories/GHSA-rq7h-c2jc-7f22)、[Zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)。

## 建议执行顺序与完成标准

1. **先修网络运行时和兼容补丁。** Node24候选、Fastify、两条fast-uri、npm Undici和命中的brace-expansion。锁精确版本/镜像digest，保留Node24主线；以受控真实SDK传输、权限/异常路由、确认重放及静态首页验证，不运行C07/C08新模型活动。这个批次优先于继续发布。
2. **再修前端工具链与序列化依赖。** 处理上述4包，根/前端锁都复核。构建、类型和路由/会话/工作区定向检查足够；只有实际行为受影响才补对应CU，不重跑历史全部样本。
3. **单独处理解析器和存储依赖的兼容性。** PDF：选择已内置修复引擎的unpdf版本，或使用其现有definePDFJSModule显式接入已修复PDF.js；核对实际引擎至少6.2.108且CMap/字体同版，再验证中文PDF、引用页码、禁外连、限时/限内存和无文本文档。不只改资源包。CSV仅在跨主版本验证通过后升级。MinIO采用有证据的兼容更新/小范围上游回补；如仍不可安全消除，明确未调用路径及残留风险供发布决策，不默认用不兼容override或整体换存储。

完成标准是“相关可达风险已消除，剩余项有具体路径、触发前提及明确处置”，不是用强制大版本升级凑audit零计数。先修复已知风险，再在当时registry上重新审计两个锁及实际运行时；版本候选仅对应本次审查日期。若新版本引入合同变化，应限定修改/验证范围，不重构Agent工作流。

## 许可证和证据限制

现有核心Deep Agents/LangChain/LangGraph为MIT，AI SDK/MinIO/PDF.js为Apache-2.0；unpdf1.8.1本身MIT但内置PDF.js仍保留其Apache来源，不能只看顶层MIT。没有发现本次核对组件需要退出架构的许可证冲突；这不是全传递依赖法律审计，依赖升级后仍需保留包内LICENSE/NOTICE并核对最终发行物。

本轮未执行漏洞载荷、依赖安装、audit fix、生产镜像扫描或业务回归；仅审计/阅读与文档核对。原验收数据、旧预算、4240应用代码及所有历史通过/失败记录均保持。统一状态见[收口汇总](review.md)。
