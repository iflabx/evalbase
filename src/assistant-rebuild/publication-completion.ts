import { SessionStore, SessionError, type TurnProof } from "./session-store.js";
import { ExecutionStore } from "./execution-store.js";

// A pending action is an execution fact, not a second plan or authorization.
export async function publicationCompletion(
  store: SessionStore,
  execution: ExecutionStore,
  proof: TurnProof,
  text: string,
  context: any,
) {
  const denied =
    /(?:不要|不必|暂不|先不|别|取消|停止).{0,8}发布|(?:如何|怎么|能否|是否|可以吗|方案|流程|解释)/u.test(
      text,
    );
  const requested = !denied && /发布/u.test(text);
  const continuing = !denied && /继续|resume|continue/i.test(text);
  const prior = (
    await store.db.query(
      "SELECT detail FROM assistant_runtime_event WHERE session_id=$1 AND kind='publication_expected' ORDER BY id DESC LIMIT 1",
      [proof.sessionId],
    )
  ).rows[0]?.detail;
  const own = (
    await store.db.query(
      "SELECT detail FROM assistant_runtime_event WHERE session_id=$1 AND turn_id=$2 AND kind='publication_expected' ORDER BY id DESC LIMIT 1",
      [proof.sessionId, proof.turnId],
    )
  ).rows[0]?.detail;
  let expected = own;
  if (denied) {
    await store.event(proof, "publication_expected", { cancelled: true });
    return {
      check: async (): Promise<{ message?: string; recover?: string }> => ({}),
    };
  }
  if (!expected && (requested || (continuing && prior && !prior.cancelled))) {
    const ref =
      context?.kind === "draft"
        ? context.id
        : (
            await store.db.query(
              "SELECT detail->'source'->>'id' id FROM assistant_runtime_event WHERE session_id=$1 AND kind='source_read' AND detail->'source'->>'kind'='draft' ORDER BY id DESC LIMIT 1",
              [proof.sessionId],
            )
          ).rows[0]?.id;
    const draft = ref
      ? (
          await store.db.query(
            "SELECT revision FROM collaborative_draft WHERE id=$1 AND project_id=$2",
            [ref, proof.projectId],
          )
        ).rows[0]
      : null;
    expected =
      continuing && !requested
        ? prior
        : {
            draftId: ref ?? null,
            revision: draft ? Number(draft.revision) : null,
          };
    await store.event(proof, "publication_expected", expected);
  }
  let attempts = Number(
    (
      await store.db.query(
        "SELECT count(*) n FROM assistant_runtime_event WHERE session_id=$1 AND turn_id=$2 AND kind='publication_recovery'",
        [proof.sessionId, proof.turnId],
      )
    ).rows[0].n,
  );
  return {
    async check(): Promise<{ message?: string; recover?: string }> {
      if (!expected) return {};
      await execution.guard(proof);
      const facts = await execution.projection(proof, proof.sessionId);
      if (!expected.draftId) {
        const candidates = [
          ...new Set(
            facts.confirmations
              .filter(
                (c: any) =>
                  c.action === "publish" && c.turn_id === proof.turnId,
              )
              .map((c: any) => c.payload?.draftId)
              .filter(Boolean),
          ),
        ];
        if (candidates.length === 1) {
          const c: any = facts.confirmations.find(
            (c: any) =>
              c.action === "publish" && c.payload?.draftId === candidates[0],
          );
          expected = {
            draftId: candidates[0],
            revision: Number(c.payload.revision),
          };
          await store.event(proof, "publication_expected", expected);
        }
      }
      const matches = facts.confirmations.filter(
        (c: any) =>
          c.action === "publish" &&
          c.payload?.draftId === expected.draftId &&
          Number(c.payload?.revision) === expected.revision,
      );
      const committed = matches.find(
        (c: any) => c.status === "committed" && c.receipt?.versionId,
      );
      if (committed)
        return { message: "发布已完成，服务端已确认。请查看对应版本。" };
      const card = matches.find(
        (c: any) =>
          c.status === "pending" &&
          new Date(c.expires_at).getTime() > Date.now(),
      );
      if (card)
        return { message: "发布确认已准备好，请在确认卡中核对并确认。" };
      if (!expected.draftId)
        throw new SessionError("publication_target_required", 422);
      const current = (
        await store.db.query(
          "SELECT revision FROM collaborative_draft WHERE id=$1 AND project_id=$2",
          [expected.draftId, proof.projectId],
        )
      ).rows[0];
      if (!current || Number(current.revision) !== expected.revision)
        throw new SessionError("draft_revision_conflict", 409);
      if (attempts >= 2)
        throw new SessionError("publication_not_complete", 422);
      attempts++;
      await store.event(proof, "publication_recovery", {
        draftId: expected.draftId,
        attempt: attempts,
      });
      return {
        recover:
          "系统核验：用户要求发布的草稿尚无有效发布确认，上一条文字不代表执行。请读取草稿 " +
          expected.draftId +
          " 的真实已保存修订，然后调用request_publish准备确认；不得代用户确认、创建其他草稿或修改内容。",
      };
    },
  };
}
