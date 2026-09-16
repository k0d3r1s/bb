import { z } from "zod";
import { defineHostDaemonCommandDescriptor } from "./commands.js";

export const hostDaemonWorkActivitySnapshotSchema = z
  .object({
    activeByKind: z.record(z.string().min(1), z.number().int().nonnegative()),
  })
  .strict();
export type HostDaemonWorkActivitySnapshot = z.infer<
  typeof hostDaemonWorkActivitySnapshotSchema
>;

const workQuiesceCommandSchema = z
  .object({
    type: z.literal("work.quiesce"),
    operationId: z.string().min(1),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
const workSealCommandSchema = z
  .object({
    type: z.literal("work.seal"),
    operationId: z.string().min(1),
  })
  .strict();
const workUnquiesceCommandSchema = z
  .object({
    type: z.literal("work.unquiesce"),
    operationId: z.string().min(1),
  })
  .strict();
const workQuiesceResultSchema = z
  .object({
    operationId: z.string().min(1),
    gatePhase: z.literal("draining"),
    activity: hostDaemonWorkActivitySnapshotSchema,
  })
  .strict();
const workSealResultSchema = z
  .object({
    operationId: z.string().min(1),
    gatePhase: z.literal("sealed"),
    activity: hostDaemonWorkActivitySnapshotSchema,
  })
  .strict();
const workUnquiesceResultSchema = z
  .object({
    operationId: z.string().min(1),
    released: z.literal(true),
  })
  .strict();

export const forkHostDaemonCommandRegistry = {
  "work.quiesce": defineHostDaemonCommandDescriptor({
    type: "work.quiesce",
    schema: workQuiesceCommandSchema,
    resultSchema: workQuiesceResultSchema,
    transport: "settled",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "work.seal": defineHostDaemonCommandDescriptor({
    type: "work.seal",
    schema: workSealCommandSchema,
    resultSchema: workSealResultSchema,
    transport: "settled",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "work.unquiesce": defineHostDaemonCommandDescriptor({
    type: "work.unquiesce",
    schema: workUnquiesceCommandSchema,
    resultSchema: workUnquiesceResultSchema,
    transport: "settled",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
};
