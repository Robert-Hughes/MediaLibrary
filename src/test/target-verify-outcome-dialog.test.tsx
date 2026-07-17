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
    runtime_tag_id: id.tag_id,
    tag_id_scope: {
      table: "TestFixture::Runtime",
      tag_id: id.tag_id,
      index: null,
    },
    copy: 4,
  },
  schema_id: id,
  write_target: {
    group1: "XMP-dc",
    group7: "ID-Test",
    tag_name: "SubjectRuntime",
  },
};

describe("TargetVerifyOutcomeDialog", () => {
  it("shows friendly and diagnostic LangAlt and offset-aware Time values", () => {
    const rights = {
      kind: "NewProperty" as const,
      schema_id: testId("XMP-dc:Rights"),
      write_target: {
        group1: "XMP-test",
        group7: "ID-Test",
        tag_name: "TestTag",
      },
    };
    const time = {
      kind: "NewProperty" as const,
      schema_id: testId("IPTC:TimeCreated"),
      write_target: {
        group1: "XMP-test",
        group7: "ID-Test",
        tag_name: "TestTag",
      },
    };
    const rightsEntry = targetVerifyOutcomeFromBackend("values.jpg", {
      target: rights,
      draft_reconciliation: { kind: "Keep" },
      display_name: "Rights",
      kind: "Mismatch",
      sent: { kind: "Text", value: "Copyright 2008" },
      before: null,
      observed: { kind: "LangAlt", value: { "x-default": "Copyright 2008" } },
      message: null,
    })!;
    const timeEntry = targetVerifyOutcomeFromBackend("values.jpg", {
      target: time,
      draft_reconciliation: { kind: "Keep" },
      display_name: "Time created",
      kind: "Mismatch",
      sent: {
        kind: "Time",
        value: {
          hour: 8,
          minute: 6,
          second: 49,
          subsecond: null,
          offset: null,
        },
      },
      before: null,
      observed: {
        kind: "Time",
        value: {
          hour: 8,
          minute: 6,
          second: 49,
          subsecond: null,
          offset: { sign: "Plus", hours: 1, minutes: 0 },
        },
      },
      message: null,
    })!;
    render(
      <TargetVerifyOutcomeDialog
        outcomes={{
          "values.jpg": {
            [metadataDraftTargetSlotToken(rights)]: rightsEntry,
            [metadataDraftTargetSlotToken(time)]: timeEntry,
          },
        }}
        onAccept={vi.fn()}
        onKeep={vi.fn()}
        onDiscard={vi.fn()}
        onDismissAll={vi.fn()}
      />,
    );
    expect(
      screen.getByText('LangAlt{x-default: "Copyright 2008"}'),
    ).toBeTruthy();
    expect(screen.getByText('Text("Copyright 2008")')).toBeTruthy();
    expect(screen.getByText("Time(08:06:49)")).toBeTruthy();
    expect(screen.getByText("Time(08:06:49+01:00)")).toBeTruthy();
    expect(screen.getByText("08:06:49+01:00")).toBeTruthy();
  });

  it("renders complete replacement diagnostics and acts on the replacement target", () => {
    const entry = targetVerifyOutcomeFromBackend("replace.jpg", {
      target: {
        kind: "NewProperty",
        schema_id: id,
        write_target: {
          group1: "XMP-test",
          group7: "ID-Test",
          tag_name: "TestTag",
        },
      },
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
    expect(screen.getByRole("button", { name: "Keep draft" })).toBeTruthy();
    expect(screen.queryByText(/repair/i)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Discard pending draft" }),
    );
    expect(onDiscard).toHaveBeenCalledWith("blocked.jpg", replacement);
  });

  it.each([
    "ReadbackFailed",
    "ReadbackInvalid",
    "MissingPostWrite",
    "FutureUnknown",
  ])(
    "offers discard and keep, but not acceptance, for %s without observed state",
    (kind) => {
      const entry = targetVerifyOutcomeFromBackend("unknown.jpg", {
        target: replacement,
        draft_reconciliation: { kind: "Keep" },
        display_name: "Subject",
        kind,
        sent: null,
        before: null,
        observed: null,
        message: "authoritative state unavailable",
      })!;
      const onDiscard = vi.fn();
      const onKeep = vi.fn();
      render(
        <TargetVerifyOutcomeDialog
          outcomes={{
            "unknown.jpg": {
              [metadataDraftTargetSlotToken(replacement)]: entry,
            },
          }}
          onAccept={vi.fn()}
          onKeep={onKeep}
          onDiscard={onDiscard}
          onDismissAll={vi.fn()}
        />,
      );
      expect(
        screen.queryByRole("button", {
          name: "Accept written/current file state",
        }),
      ).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Keep draft" }));
      expect(onKeep).toHaveBeenCalledWith("unknown.jpg", replacement);
      fireEvent.click(
        screen.getByRole("button", { name: "Discard pending draft" }),
      );
      expect(onDiscard).toHaveBeenCalledWith("unknown.jpg", replacement);
    },
  );

  it.each([
    ["Mismatch", { kind: "Text", value: "observed" }],
    ["Coerced", { kind: "Integer", value: 1 }],
    ["DeleteLingering", { kind: "Text", value: "lingering" }],
    ["Mismatch", { kind: "Null" }],
  ] as const)(
    "offers acceptance for %s with authoritative observed state",
    (kind, observed) => {
      const entry = targetVerifyOutcomeFromBackend("observed.jpg", {
        target: replacement,
        draft_reconciliation: { kind: "Keep" },
        display_name: "Subject",
        kind,
        sent: null,
        before: null,
        observed,
        message: null,
      })!;
      const onAccept = vi.fn();
      render(
        <TargetVerifyOutcomeDialog
          outcomes={{
            "observed.jpg": {
              [metadataDraftTargetSlotToken(replacement)]: entry,
            },
          }}
          onAccept={onAccept}
          onKeep={vi.fn()}
          onDiscard={vi.fn()}
          onDismissAll={vi.fn()}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: "Accept written/current file state",
        }),
      );
      expect(onAccept).toHaveBeenCalledWith("observed.jpg", replacement);
      expect(screen.getByRole("button", { name: "Keep draft" })).toBeTruthy();
    },
  );
});
