# Phase 1A-15：安全加固

Status: ready-for-agent
Implementation: completed

Blocked by: [05](./05-mapping-and-formal-schema.md), [11](./11-delivery-packages-and-langfuse-csv.md), [12](./12-permissions-and-project-isolation.md), [14](./14-controlled-deletion.md)

## Outcome

恶意但合成的文件名、Source Record、metadata、Schema、CSV cell、ZIP 和请求可以贯穿相关公开接口而不会执行脚本/公式、访问网络、突破资源限制或把 session、密钥、Prompt/record 正文写入日志和错误。

## Required reading

- [Implementation Spec](../spec.md)，重点为 Security tests
- [PRD security boundary](../../../docs/PRD-v2-test-data-management.md#143-安全与隐私)
- [Decision record](../../../docs/reviews/phase1a-solo-owner-decision-record.md)
- [Test plan](../../../docs/test-plan-phase1a.md)，重点为 F.6 和安全 Fixture
- [ADR-0005](../../../docs/adr/0005-deterministic-artifacts-and-offline-validation.md)
- [ADR-0006](../../../docs/adr/0006-formal-schema-and-compatibility.md)

## Vertical slice

| Layer            | Deliverable                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| Data             | synthetic security canary Fixture、safe diagnostic refs、无数据正文的 audit/log fields               |
| Domain           | 不可信显示值编码边界、CSV formula policy、Schema/ZIP resource policy 和 fail-closed validation       |
| Public interface | session/CSRF/Origin/request-size、safe error、download/package/validator 输入边界                    |
| UI               | 所有不可信字段安全显示、风险警告、无 raw HTML/Markdown 执行                                          |
| Tests            | 浏览器 injection、CSV spreadsheet oracle、Schema 禁网/资源、ZIP corruption、secret canary 全输出扫描 |

## Acceptance Criteria

1. filename、Source Attribution、Source Record、mapping result、metadata、error 和 Audit 中的 HTML/Markdown/script/event/URL payload 只作为文本显示。
2. UI 不使用不可信 raw HTML；键盘与错误显示修复不能重新引入执行路径。
3. `=`、`+`、`-`、`@`、TAB 和 CR 公式前缀在约定 spreadsheet oracle 中不执行，同时正式 JSON 语义仍可核对。
4. Formal Schema 拒绝远程 `$ref`、validation-time network/database access、超过大小/深度/属性/关键字限制、危险 regex 和未设限递归。
5. Offline Validator 在解压前/过程中拒绝 traversal、absolute path、duplicate path、symlink、unsupported compression 和 zip bomb/resource overflow。
6. 所有 mutation 拒绝无效 CSRF/Origin；所有 upload/request 遵守流式 size limit。
7. HTTP error、Worker error、日志、metrics、Audit view、CLI stdout/stderr 不出现 F-SECRET-CANARY 的 password/session/key/raw record/Prompt 内容。
8. 下载仍需 Ticket 12 的请求时授权；MinIO credential 和 public URL 不进入浏览器或日志。
9. Viewer raw/Full Package 正向安全测试只使用合成非敏感 Fixture，并显示已接受范围限制。
10. 安全测试通过不被描述为生产安全认证；公网、真实多人和敏感数据仍为 Production Gate。

PRD trace: AC-34 的 CSV 安全部分、AC-39，以及安全 Definition of Done。

## Out of scope

- 生产 TLS、WAF、SSO、企业 secret manager、渗透认证、事件响应平台或真实敏感数据。
- 任何 Production Gate 的批准。

## Definition of Done

- 所有不可信输入 Fixture 在 S-HTTP/S-CLI/S-BROWSER 上通过。
- canary 扫描覆盖成功和失败路径，结果为零泄漏。
- 安全失败返回稳定非敏感诊断，不静默放行。

## Comments

- **2026-08-26 — Implementation commit exists at `b97a039`; lifecycle completion remains pending the required Ticket Closure Review.**

- **2026-08-26 — Implementation commit `b97a039`.** Hardened the public error boundary: unknown routes return stable `route_not_found`; malformed JSON returns `400 request_body_invalid`; request size/content-type failures retain stable mappings; unexpected server failures return `http_error` while emitting a sanitized structured log with correlation ID, method, route pattern, stage, status, and stable error code rather than URL/query/body/exception text. Raw asset downloads now use a fixed safe download filename instead of echoing an untrusted upload filename in `Content-Disposition`, while the asset response/UI displays the original filename as text. Added security coverage for browser HTML/script/event/Markdown-link execution, Source Attribution, Source Record, filename, mapping/metadata, structured errors, Audit output, all six spreadsheet formula prefixes, Formal Schema remote/resource/size/depth/property dangers, CSRF on all Controlled Deletion mutations, Worker/Job/Audit failure canaries, successful raw download headers, and valid/corrupt/unsafe CLI stdout/stderr.
- Public evidence at `b97a039`: `tests/integration/security-hardening.test.ts` covers S-HTTP safe errors, deletion CSRF ordering, a real upload/object-read Worker failure with captured structured output, successful download headers, public Job/Audit canary scanning, and resource-unsafe Formal Schema rejection. `tests/e2e/security-hardening.spec.ts` drives a malicious upload through parse, mapping metadata, publication, fixed-version case query, and Audit display, asserting text-only rendering and no script/image/dialog execution. `tests/e2e/permissions.spec.ts` verifies the Viewer synthetic non-sensitive fixture and accepted non-production limitation disclosure. Existing/expanded unit suites prove all `= + - @ TAB CR` CSV prefixes decode as non-formula JSON cells and valid/unsafe/corrupt Validator CLI outputs do not expose canaries.
- Pre-closure validation at `b97a039`: `npm run format:check`, `npm run typecheck`, `npm run lint`, and `npm test` passed (`15` files / `117` tests). Fixed-Node-24 integration with migration passed (`18` files / `163` tests), complete browser E2E passed (`24` tests), `npm run docs:check`, `git diff --check`, and fixed-Node-24 Compose build passed. The pre-commit Standards + Spec code review found no unresolved P0/P1 after repairs; the required Closure Review remains pending.
- **Boundary:** metrics output and the complete G-15 metric/error catalog remain owned by Ticket 16; this ticket scans all currently existing diagnostic surfaces and does not invent a speculative metrics system. Security pass remains non-production evidence only and does not approve public internet exposure, real sensitive data, production TLS/WAF/SSO, or Production Gate. Non-production Gate remains `Passed`; Production Gate remains `Not Evaluated / Not Approved`.
- **2026-08-26 — Ticket Closure Review P0/P1 cleared at `d027250` (baseline `e01ac87`).** The unchanged closure matrix covered AC-1/2 through S-BROWSER text-only rendering; AC-3 through S-CLI CSV formula oracle; AC-4/5 through Formal Schema and Offline Validator resource/ZIP rejection; AC-6/8 through S-HTTP CSRF/Origin, request-size, request-time download authorization, and credential/public-URL boundaries; AC-7 through HTTP/Worker/Audit/CLI canary scans (metrics remain the explicit Ticket 16 boundary); AC-9/10 through the synthetic non-sensitive Viewer fixture and non-production-only disclosures. Positive, negative, validation, authorization, error, retry, cancellation, persistence, concurrency, cross-Ticket, Phase 1B, and Production Gate boundaries were inspected against the referenced Spec, PRD, architecture, ADRs, test plan, and `AGENTS.md`. Standards review: 0 P0 / 0 P1 / 0 P2. Spec review: 0 P0 / 0 P1 / 0 P2. The repair commits `06ade08` and `d027250` removed unrelated Ticket 05/06 E2E changes and all fixed waits from the reviewed diff. No P2 findings were accepted. Current evidence includes `npm test` (15 files / 117 tests), `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run docs:check`, `git diff --check`, targeted security E2E in the internal Playwright container (1/1 passed), and the Ticket 06 capacity E2E (1/1 passed). Untested claims are explicitly retained: this review did not rerun all integration suites because host execution cannot resolve Docker-only `postgres`/`minio` names and the existing Worker is active; the prior fixed-Node-24 integration (18 files / 163 tests) and full E2E (24 tests) evidence remains at `b97a039`. The running deployment reports `92b1afc`, so it is not deployment evidence for this docs/test-only HEAD; no runtime source changed after `b97a039`. Non-production Gate remains `Passed`; Production Gate remains `Not Evaluated / Not Approved`; Ticket 16 remains separately `not-started` and requires Project Owner authorization.
