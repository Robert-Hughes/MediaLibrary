import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TargetVerifyOutcomeDialog } from "../components/TargetVerifyOutcomeDialog";
import { targetVerifyOutcomeFromBackend } from "../targetVerifyOutcomes";
import { metadataDraftTargetSlotToken } from "../utils/metadataDraftTarget";
import { recordFromEntries } from "../utils/stringRecord";
import { testId } from "./factories";

const id = testId("XMP-dc:Subject");
const replacement = {
  kind: "ExistingOccurrence" as const,
  occurrence_id: {
    document: null,
    path: "JPEG-APP1-XMP",
    tag_id: id.tag_id,
    copy: 4,
  },
  schema_id: id,
  write_target: { group1: "XMP-dc", tag_name: "SubjectRuntime" },
};

describe("TargetVerifyOutcomeDialog", () => {
  it("renders complete replacement diagnostics and acts on the replacement target", () => {
    const entry = targetVerifyOutcomeFromBackend("replace.jpg", {
      target: { kind: "NewProperty", schema_id: id },
      draft_reconciliation: { kind: "Replace", target: replacement },
      display_name: "Hierarchical subject",
      kind: "Mismatch",
      sent: { kind: "Text", value: "requested" },
      before: { kind: "Text", value: "previous" },
      observed: { kind: "Text", value: "observed" },
      message: "backend verification message",
    })!;
    const outcomes = recordFromEntries([
      [
        "replace.jpg",
        recordFromEntries([[metadataDraftTargetSlotToken(replacement), entry]]),
      ],
    ]);
    const onAccept = vi.fn();
    const onKeep = vi.fn();
    render(
      <TargetVerifyOutcomeDialog
        outcomes={outcomes}
        onAccept={onAccept}
        onKeep={onKeep}
        onDiscard={vi.fn()}
        onDismissAll={vi.fn()}
      />,
    );

    const row = screen.getByTestId(
      `target-verify-row-replace.jpg-${metadataDraftTargetSlotToken(replacement)}`,
    );
    for (const text of [
      "Hierarchical subject",
      "Existing Occurrence",
      "SubjectRuntime",
      "Replace",
      "Mismatch",
      "requested",
      "previous",
      "observed",
      "backend verification message",
      "New Property",
    ]) {
      expect(within(row).getAllByText(new RegExp(text)).length).toBeGreaterThan(
        0,
      );
    }
    fireEvent.click(
      within(row).getByRole("button", {
        name: "Accept written/current file state",
      }),
    );
    expect(onAccept).toHaveBeenCalledWith("replace.jpg", replacement);
    fireEvent.click(within(row).getByRole("button", { name: "Keep draft" }));
    expect(onKeep).toHaveBeenCalledWith("replace.jpg", replacement);
  });

  it("shows blocked reason and offers no accept or automatic repair", () => {
    const entry = targetVerifyOutcomeFromBackend("blocked.jpg", {
      target: replacement,
      draft_reconciliation: {
        kind: "Blocked",
        reason: "occurrence selector became stale",
      },
      display_name: "Subject",
      kind: "Blocked",
      sent: null,
      before: null,
      observed: null,
      message: null,
    })!;
    const onDiscard = vi.fn();
    render(
      <TargetVerifyOutcomeDialog
        outcomes={{
          "blocked.jpg": {
            [metadataDraftTargetSlotToken(replacement)]: entry,
          },
        }}
        onAccept={vi.fn()}
        onKeep={vi.fn()}
        onDiscard={onDiscard}
        onDismissAll={vi.fn()}
      />,
    );
    expect(screen.getByText(/occurrence selector became stale/)).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Accept written/current file state",
      }),
    ).toBeNull();
    expect(screen.queryByText(/repair/i)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Discard pending draft" }),
    );
    expect(onDiscard).toHaveBeenCalledWith("blocked.jpg", replacement);
  });
});
