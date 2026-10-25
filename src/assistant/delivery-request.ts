type GoalRef = { id: string; name: string };
const ordinalNumber = (s: string) =>
  Number(s) ||
  (
    {
      一: 1,
      二: 2,
      两: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
      十: 10,
    } as Record<string, number>
  )[s];
/** Resolve only explicit current-user clauses against the current delivery order.
 * Preservation and negated cancellation are never amendment targets. Unknown or
 * conflicting references stay unresolved; model-proposed IDs cannot grant removal.
 */
export function deliveryRequest<T extends GoalRef>(
  goals: T[],
  request: string,
) {
  return request
    .split(/[，,。；;\n]/u)
    .filter(Boolean)
    .map((text) => {
      const negatedCancel =
        /(?:不(?:要|得|用|必|能)?|无需|别|禁止|勿).{0,8}(?:取消|撤销|删除|去掉)/u.test(
          text,
        );
      const question = /如果|假如|例如|比如|是否|能不能|要不要|[？?]/u.test(
        text,
      );
      const paused = /(?:先|暂时?|目前)不(?:做|要|执行|处理)|暂停|稍后再/u.test(
        text,
      );
      const cancel =
        !negatedCancel &&
        !question &&
        !paused &&
        /取消|撤销|删除|去掉|不要了|不再需要/u.test(text);
      const preserve = negatedCancel || /保留|保持|不变/u.test(text);
      const operation = preserve
        ? "preserve"
        : paused
          ? "pause"
          : cancel
            ? "remove"
            : /不要|不得|禁止/u.test(text)
              ? "preserve"
              : "change";
      const ordinals = [
        ...text.matchAll(/第(\d+|一|二|两|三|四|五|六|七|八|九|十)(?:份|个)/gu),
      ].map((m) => goals[ordinalNumber(m[1]) - 1]);
      const named = goals.filter((g) => text.includes(g.name));
      const conflicting =
        ordinals.some((g) => !g) ||
        (ordinals.length > 0 && named.some((g) => !ordinals.includes(g)));
      const targets = conflicting
        ? []
        : ordinals.length
          ? ordinals.filter((g): g is T => Boolean(g))
          : named.length
            ? named
            : /全部|所有|每份|各份/u.test(text)
              ? goals
              : [];
      return {
        text,
        operation,
        targets: [...new Map(targets.map((g) => [g.id, g])).values()],
        conflicting,
      };
    });
}
