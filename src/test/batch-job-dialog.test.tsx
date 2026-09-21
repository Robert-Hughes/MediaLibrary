import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

describe.each<BatchJobPhase>(["estimating", "running"])(
  "BatchJobDialog %s focus",
  (phase) => {
    it("keeps Enter neutral while the operation is in progress", async () => {
      const onCancel = vi.fn();
      render(
        <BatchJobDialog
          testidPrefix="job"
          phase={phase}
          title="Job"
          onCancel={onCancel}
          onClose={vi.fn()}
        >
          <button onClick={onCancel}>Cancel</button>
        </BatchJobDialog>,
      );

      const content = screen
        .getByRole("dialog")
        .querySelector(".dialog-content");
      expect(content).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      expect(onCancel).not.toHaveBeenCalled();
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
