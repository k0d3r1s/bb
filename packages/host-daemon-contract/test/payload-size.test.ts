import { gzipSync } from "node:zlib";
import { turnScope, type ThreadEvent } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  groupHostDaemonEvents,
  type HostDaemonEventEnvelope,
  ungroupHostDaemonEvents,
} from "../src/session.js";

interface PayloadSize {
  gzipBytes: number;
  jsonBytes: number;
}

function payloadSize(value: unknown): PayloadSize {
  const json = JSON.stringify(value);
  return {
    gzipBytes: gzipSync(json).byteLength,
    jsonBytes: Buffer.byteLength(json),
  };
}

function event(index: number): ThreadEvent {
  return {
    type: "item/agentMessage/delta",
    threadId: "thr_payload_measurement_123456789",
    providerThreadId: "provider_payload_measurement_123456789",
    scope: turnScope("turn_payload_measurement_123456789"),
    itemId: "item_payload_measurement_123456789",
    delta: `streamed token chunk ${index} `,
  };
}

describe("daemon-to-server event payload sizes", () => {
  it("preserves event order when a thread recurs after another thread", () => {
    const envelopes: HostDaemonEventEnvelope[] = [
      { threadId: "thr_a", event: event(1) },
      { threadId: "thr_b", event: event(2) },
      { threadId: "thr_a", event: event(3) },
    ];

    const groups = groupHostDaemonEvents(envelopes);

    expect(groups.map((group) => group.threadId)).toEqual([
      "thr_a",
      "thr_b",
      "thr_a",
    ]);
    expect(ungroupHostDaemonEvents(groups)).toEqual(envelopes);
  });

  it("records legacy-envelope and grouped sizes across representative batches", () => {
    const measurements = [1, 10, 50].map((eventCount) => {
      const events: HostDaemonEventEnvelope[] = Array.from(
        { length: eventCount },
        (_, index) => ({
          threadId: "thr_payload_measurement_123456789",
          event: event(index),
        }),
      );
      const legacyPayload = {
        sessionId: "session_payload_measurement_123456789",
        events,
      };
      const groupedPayload = {
        sessionId: "session_payload_measurement_123456789",
        eventGroups: groupHostDaemonEvents(events),
      };
      return {
        eventCount,
        legacyEnvelope: payloadSize(legacyPayload),
        grouped: payloadSize(groupedPayload),
      };
    });

    expect(measurements).toEqual([
      {
        eventCount: 1,
        legacyEnvelope: { gzipBytes: expect.any(Number), jsonBytes: 413 },
        grouped: { gzipBytes: expect.any(Number), jsonBytes: 421 },
      },
      {
        eventCount: 10,
        legacyEnvelope: { gzipBytes: expect.any(Number), jsonBytes: 3_554 },
        grouped: { gzipBytes: expect.any(Number), jsonBytes: 3_049 },
      },
      {
        eventCount: 50,
        legacyEnvelope: { gzipBytes: expect.any(Number), jsonBytes: 17_554 },
        grouped: { gzipBytes: expect.any(Number), jsonBytes: 14_769 },
      },
    ]);

    const gzipBudgets = [
      { legacyEnvelope: 200, grouped: 205 },
      { legacyEnvelope: 250, grouped: 250 },
      { legacyEnvelope: 410, grouped: 410 },
    ];
    for (const [index, measurement] of measurements.entries()) {
      const budget = gzipBudgets[index];
      expect(budget).toBeDefined();
      expect(measurement.legacyEnvelope.gzipBytes).toBeLessThanOrEqual(
        budget?.legacyEnvelope ?? 0,
      );
      expect(measurement.grouped.gzipBytes).toBeLessThanOrEqual(
        budget?.grouped ?? 0,
      );
      if (index > 0) {
        expect(measurement.grouped.jsonBytes).toBeLessThan(
          measurement.legacyEnvelope.jsonBytes,
        );
      }
    }
  });
});
