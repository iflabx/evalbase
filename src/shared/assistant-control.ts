/** Only standalone, unambiguous user controls bypass the ordinary turn mutex. */
export function isPauseRequest(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 80) return false;
  const text = value.trim().replace(/[。！!，,？?\s]/gu, "");
  return /^(?:请|麻烦)?(?:先)?(?:暂停|停止|停)(?:一下|一会儿|一会|当前任务|当前执行|后续执行|任务|执行)?(?:吧|好吗)?$/u.test(
    text,
  );
}
