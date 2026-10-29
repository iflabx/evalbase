/** Pure control must consume the whole command: business payloads never inherit
 * authorization from a matching prefix. Unsupported/ambiguous requests stay paused.
 */
export function resumeIntent(
  text: string,
): "none" | "continue" | "amend-and-continue" {
  const quoted = [...text.matchAll(/[“]([^”]*)[”]|"([^"\n]*)"|「([^」]*)」/gu)];
  if (
    quoted.length &&
    (quoted.length !== 1 ||
      requestedSaveName(text) !==
        (quoted[0]?.[1] ?? quoted[0]?.[2] ?? quoted[0]?.[3]))
  )
    return "none";
  const control = text
    .trim()
    .replace(/[“][^”]*[”]|"[^"\n]*"|「[^」]*」/gu, "")
    .replace(/[。！.!\s]+$/u, "");
  if (
    /[?？]|不|别|仅|只|能否|是否|如果|假如|之后再|之前|前先|什么|怎么|如何|吗|讨论|解释|看看|查看|查询|[“”"「」]/u.test(
      control,
    )
  )
    return "none";
  const prefix =
    "(?:(?:好的|好|可以)[，,\\s]*)?(?:请(?:你)?|麻烦(?:你)?)?(?:现在)?";
  const verb = "(?:继续|接着|恢复)";
  const pure =
    "(?:(?:执行|处理|完成|做)?(?:(?:原来|刚才|之前|当前|这个|上次|原)的?)?(?:任务|工作|处理)?|保存(?:已经|已)?(?:处理)?(?:完成)?的?(?:结果|内容|数据)?|[，,、 ]*(?:并|然后|再)?(?:让|请)我确认保存)(?:吧|一下)?";
  if (
    new RegExp("^" + prefix + verb + pure + "$", "u").test(control) ||
    /^(?:please )?(?:continue|resume)(?: (?:the )?(?:task|work))?$/i.test(
      control,
    )
  )
    return "continue";
  // Only the existing save-name amendment is routed here; other business
  // amendments still require explicit domain tools rather than auto-resume.
  const target = "[^，,。；;]*";
  if (
    new RegExp(
      "^" +
        prefix +
        verb +
        "[，,、 ]*(?:完成后)?(?:保存成|保存为|保存到|另存为)" +
        target +
        "$",
      "u",
    ).test(control) ||
    new RegExp(
      "^" +
        prefix +
        "先?(?:把)?保存名称改(?:成|为)" +
        target +
        "[，,；;](?:然后|再|并)?" +
        verb +
        "(?:吧)?$",
      "u",
    ).test(control)
  )
    return "amend-and-continue";
  return "none";
}
export function requestedSaveName(text: string): string | undefined {
  const value = text.match(
    /(?:保存名称改(?:成|为)|保存(?:成|为|到)|另存为|确认保存)\s*(?:“([^”]+)”|"([^"\n]+)"|「([^」]+)」|([^，,。；;]+))/u,
  );
  return value
    ? (value[1] ?? value[2] ?? value[3] ?? value[4])?.trim()
    : undefined;
}
export function explicitResumeRequest(text: string): boolean {
  return resumeIntent(text) !== "none";
}
