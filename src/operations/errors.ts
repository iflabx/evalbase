/** Shared business failure shape; independent of assistant planning and persistence. */
export class BusinessError extends Error {
  constructor(
    public status: number,
    public code: string,
    public hint?: string,
  ) {
    super(code);
  }
}
