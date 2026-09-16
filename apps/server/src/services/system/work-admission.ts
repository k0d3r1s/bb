import { assertWorkAdmissionOpen, type DbTransaction } from "@bb/db";
import { ApiError } from "../../errors.js";

export function requireWorkAdmissionOpen(tx: DbTransaction): void {
  const admission = assertWorkAdmissionOpen(tx);
  if (admission.kind === "open") return;
  throw new ApiError(
    503,
    admission.code,
    `Work admission is closed for maintenance: ${admission.lease.reason}`,
    {
      retryable: true,
      details: {
        operationId: admission.lease.operationId,
        expiresAt: admission.lease.expiresAt,
      },
    },
  );
}
