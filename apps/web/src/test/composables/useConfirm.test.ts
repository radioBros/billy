import { describe, it, expect } from "vitest";
import { confirm, resolveConfirm, confirmState } from "@/composables/useConfirm";

describe("useConfirm", () => {
  it("opens the dialog with the given options and resolves true on confirm", async () => {
    const p = confirm({ title: "Delete?", message: "Sure?", confirmText: "Yes", tone: "error" });
    expect(confirmState.open).toBe(true);
    expect(confirmState.title).toBe("Delete?");
    expect(confirmState.message).toBe("Sure?");
    expect(confirmState.confirmText).toBe("Yes");
    expect(confirmState.tone).toBe("error");

    resolveConfirm(true);
    await expect(p).resolves.toBe(true);
    expect(confirmState.open).toBe(false);
  });

  it("resolves false on cancel", async () => {
    const p = confirm({ title: "T", message: "M" });
    resolveConfirm(false);
    await expect(p).resolves.toBe(false);
  });

  it("defaults tone to primary and leaves confirm/cancel text null", () => {
    void confirm({ title: "T", message: "M" });
    expect(confirmState.tone).toBe("primary");
    expect(confirmState.confirmText).toBeNull();
    expect(confirmState.cancelText).toBeNull();
    resolveConfirm(false);
  });

  it("resolves a prior pending prompt as false when a new one opens", async () => {
    const first = confirm({ title: "First", message: "M" });
    const second = confirm({ title: "Second", message: "M" });
    await expect(first).resolves.toBe(false);
    expect(confirmState.title).toBe("Second");
    resolveConfirm(true);
    await expect(second).resolves.toBe(true);
  });
});
