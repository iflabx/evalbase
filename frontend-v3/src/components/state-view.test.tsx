import { afterEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { CopyableId } from "./state-view";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([true, false])("reports the actual HTTP clipboard fallback result: %s", async (copied) => {
  const field = { value: "", style: {}, select: vi.fn(), remove: vi.fn() };
  const focus = vi.fn();
  const execCommand = vi.fn(() => copied);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("document", {
    activeElement: { focus },
    createElement: vi.fn(() => field),
    body: { appendChild: vi.fn() },
    execCommand,
  });
  await CopyableId({ value: "http-id" }).props.onClick();
  expect(field.value).toBe("http-id");
  expect(field.select).toHaveBeenCalledOnce();
  expect(execCommand).toHaveBeenCalledWith("copy");
  expect(field.remove).toHaveBeenCalledOnce();
  expect(focus).toHaveBeenCalledOnce();
  expect(toast.success).toHaveBeenCalledTimes(copied ? 1 : 0);
  expect(toast.error).toHaveBeenCalledTimes(copied ? 0 : 1);
});

it("waits for native clipboard success before claiming that copying succeeded", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  await CopyableId({ value: "secure-id" }).props.onClick();
  expect(writeText).toHaveBeenCalledWith("secure-id");
  expect(toast.success).toHaveBeenCalledOnce();
});

it("reports a rejected native clipboard write without a false success", async () => {
  vi.stubGlobal("navigator", {
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error("permission denied")) },
  });
  await CopyableId({ value: "secure-id" }).props.onClick();
  expect(toast.success).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledOnce();
});
