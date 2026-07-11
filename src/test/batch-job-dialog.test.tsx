import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  BatchJobDialog,
  type BatchJobPhase,
} from "../components/BatchJobDialog";

describe.each<BatchJobPhase>(["estimating", "awaiting-confirm", "running"])(
  "BatchJobDialog %s phase",
  (phase) => {
    it("routes one cancel request only to onCancel", () => {
      const onCancel = vi.fn();
      const onClose = vi.fn();
      render(
        <BatchJobDialog
          testidPrefix="job"
          phase={phase}
          title="Job"
          onCancel={onCancel}
          onClose={onClose}
        >
          body
        </BatchJobDialog>,
      );
      screen
        .getByRole("dialog")
        .dispatchEvent(new Event("cancel", { cancelable: true }));
      expect(onCancel).toHaveBeenCalledOnce();
      expect(onClose).not.toHaveBeenCalled();
    });
  },
);

describe("BatchJobDialog done phase", () => {
  it("routes one cancel request only to onClose", () => {
    const onCancel = vi.fn();
    const onClose = vi.fn();
    render(
      <BatchJobDialog
        testidPrefix="job"
        phase="done"
        title="Job"
        onCancel={onCancel}
        onClose={onClose}
      >
        body
      </BatchJobDialog>,
    );
    screen
      .getByRole("dialog")
      .dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
