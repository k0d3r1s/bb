import { promoteBranch } from "./host/branch-promotion.js";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { createHostProgress } from "bb-environment-provider-host/progress";
import { checkoutHostContract, checkoutHostSignals } from "./contract.js";
import { attachCheckout, inspectCheckout } from "./host/checkout.js";

export function createCheckoutHostEntry() {
  return experimental_defineHostEntry({
    contract: checkoutHostContract,
    experimental_signals: checkoutHostSignals,
    handlers: {
      async promoteBranch(input, context) {
        return promoteBranch({
          request: input,
          dataDir: context.experimental_paths.dataDir,
          signal: context.signal,
          onProgress: createHostProgress({
            operationId: input.intent.operationId,
            emit: (payload) =>
              context.experimental_emitSignal("progress", payload),
          }),
        });
      },
      async attach(input, context) {
        try {
          const attached = await attachCheckout({
            path: input.path,
            branch: input.branch,
            onProgress: createHostProgress({
              operationId: input.operationId,
              emit: (payload) =>
                context.experimental_emitSignal("progress", payload),
            }),
            signal: context.signal,
          });
          return { status: "attached", ...attached } as const;
        } catch (error) {
          if (context.signal.aborted) throw error;
          return {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          } as const;
        }
      },
      async inspectCheckout(input) {
        return await inspectCheckout({ path: input.path });
      },
    },
  });
}

export default createCheckoutHostEntry();
