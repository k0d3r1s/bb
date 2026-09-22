// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { makeThread } from "@bb/test-helpers/domain-fixtures";
import type { ThreadBranchPromotionResponse } from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import { BranchPromotionRow } from "./BranchPromotionRow.fork";

const operation = {
  operationId: "operation",
  phase: "reconciling",
  intent: {
    operationId: "operation",
    path: "/checkout",
    sourceBranch: "main",
    sourceHead: "a".repeat(40),
    target: { kind: "new", name: "bb/change" },
  },
  snapshot: {
    operationId: "operation",
    phase: "uncertain",
    branchName: "bb/change",
    headSha: "a".repeat(40),
    observation: "observation",
    commandTerminated: true,
    resolution: null,
    message: null,
    replayed: true,
  },
} satisfies NonNullable<ThreadBranchPromotionResponse>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("inspects before offering recovery and submits the exact operation observation", async () => {
  const inspect = vi
    .spyOn(sdk.threads, "inspectBranchPromotion")
    .mockResolvedValue(operation);
  const resolve = vi
    .spyOn(sdk.threads, "resolveBranchPromotion")
    .mockResolvedValue(operation);
  const thread = makeThread({
    promotionTarget: "branch",
    worktreePromotion: "armed",
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BranchPromotionRow thread={thread} />
    </QueryClientProvider>,
  );
  expect(inspect).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Inspect branch promotion" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Accept current target" }),
  );
  await waitFor(() =>
    expect(resolve).toHaveBeenCalledWith({
      threadId: thread.id,
      operationId: "operation",
      observation: "observation",
      resolution: "accept-current",
    }),
  );
});

it.each([false, true])(
  "keeps acceptance disabled for a live command or different target (terminated: %s)",
  async (terminated) => {
    vi.spyOn(sdk.threads, "inspectBranchPromotion").mockResolvedValue({
      ...operation,
      snapshot: {
        ...operation.snapshot,
        commandTerminated: terminated,
        branchName: "main",
      },
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BranchPromotionRow
          thread={makeThread({ promotionTarget: "branch" })}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect branch promotion" }),
    );
    const accept = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Accept current target",
    });
    expect(accept.disabled).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Keep current checkout and skip promotion",
      }).disabled,
    ).toBe(!terminated);
  },
);

it("shows a stale-observation refusal until the user inspects again", async () => {
  const inspect = vi
    .spyOn(sdk.threads, "inspectBranchPromotion")
    .mockResolvedValue(operation);
  vi.spyOn(sdk.threads, "resolveBranchPromotion").mockRejectedValue(
    new Error("Checkout observation changed; inspect again before resolving"),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BranchPromotionRow thread={makeThread({ promotionTarget: "branch" })} />
    </QueryClientProvider>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Inspect branch promotion" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Accept current target" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Checkout observation changed",
  );
  expect(inspect).toHaveBeenCalledTimes(1);
  fireEvent.click(
    screen.getByRole("button", { name: "Inspect branch promotion" }),
  );
  await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
