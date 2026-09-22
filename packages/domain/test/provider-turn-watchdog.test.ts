import { describe, expect, it } from "vitest";
import {
  providerTurnWatchdogActivityEventTypeValues,
  providerTurnWatchdogThreadScopedActivityEventTypeValues,
  threadEventScopePolicyByType,
} from "../src/index.js";

describe("provider turn watchdog activity event types", () => {
  it("derives the thread-scoped activity list from the scope policy", () => {
    expect(providerTurnWatchdogThreadScopedActivityEventTypeValues).toEqual(
      providerTurnWatchdogActivityEventTypeValues.filter(
        (eventType) => threadEventScopePolicyByType[eventType] === "thread",
      ),
    );
  });

  it("restricts thread-scoped watchdog activity to the background task family", () => {
    expect(providerTurnWatchdogThreadScopedActivityEventTypeValues).toEqual([
      "item/backgroundTask/progress",
      "item/backgroundTask/completed",
    ]);
  });
});
