/** Conservative text authorization; ambiguous language can use the explicit Continue control. */
export function explicitResumeRequest(text: string): boolean {
  const value = text.trim().replace(/[。！.!\s]+$/u, "");
  // A leading imperative may include a save-target amendment. Negative,
  // conditional and interrogative phrases do not authorize continuation.
  const control = value.replace(/[“”][^“”]*[“”]/gu, "");
  if (
    !/[?？]|不|别|仅|只|能否|是否|如果|假如|之后再|什么|怎么|如何|吗|[“”"「」]/u.test(
      control,
    ) &&
    /^(?:(?:好的|好|可以)[，,\s]*)?(?:请(?:你)?)?(?:现在)?(?:继续|接着|恢复)(?:[，,、 ]*(?:保存|执行|处理)|[，,、 ]*完成后保存)/u.test(
      control,
    )
  )
    return true;
  return (
    /^(?:(?:好的|好|可以)[，,\s]*)?(?:请(?:你)?|麻烦(?:你)?)?(?:现在)?(?:继续|接着|恢复)(?:(?:执行|处理|完成|做))?(?:(?:原来|刚才|之前|当前|这个|上次|原)(?:的)?)?(?:任务|工作|处理)?(?:吧|一下)?$/u.test(
      value,
    ) ||
    /^(?:please )?(?:continue|resume)(?: (?:the )?(?:task|work))?$/i.test(value)
  );
}
