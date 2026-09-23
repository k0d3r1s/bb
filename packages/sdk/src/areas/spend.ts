import type {
  SpendBackfillResponse,
  SpendGroupByQueryValue,
  SpendRollupResponse,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface SpendRollupArgs {
  from?: string;
  groupBy?: SpendGroupByQueryValue;
  providerId?: string;
  signal?: AbortSignal;
  threadId?: string;
  to?: string;
}

export interface SpendBackfillArgs {
  signal?: AbortSignal;
}

export type SpendRollupResult = SpendRollupResponse;
export type SpendBackfillResult = SpendBackfillResponse;
export interface SpendArea {
  backfill(args?: SpendBackfillArgs): Promise<SpendBackfillResult>;
  rollup(args?: SpendRollupArgs): Promise<SpendRollupResult>;
}

export function createSpendArea(args: CreateSdkAreaArgs): SpendArea {
  const { transport } = args;
  return {
    async backfill(input = {}) {
      return transport.readJson(
        transport.api.v1.spend.backfill.$post(
          {},
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async rollup(input = {}) {
      const query: Record<string, string> = {};
      if (input.from !== undefined) query.from = input.from;
      if (input.to !== undefined) query.to = input.to;
      if (input.groupBy !== undefined) query.groupBy = input.groupBy;
      if (input.threadId !== undefined) query.threadId = input.threadId;
      if (input.providerId !== undefined) query.providerId = input.providerId;
      return transport.readJson(
        transport.api.v1.spend.rollup.$get(
          { query },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
  };
}
