const THREAD_RESULT_LIMIT_BYTES = 80_000;

function deny(message) {
  throw new Error(`Shared runtime denied: ${message}`);
}

function parseThreadId(params) {
  const threadId = params?.threadId;
  if (
    typeof threadId !== "string" ||
    threadId.length > 100 ||
    !/^thr_[a-z0-9]+$/.test(threadId)
  ) {
    deny("thread id is missing or invalid");
  }
  return threadId;
}

function resultPayload(thread, output, outputTruncated) {
  return {
    thread: {
      id: thread.id,
      title: thread.title,
      status: thread.status,
      providerId: thread.providerId,
      visibility: thread.visibility,
      archivedAt: thread.archivedAt,
      updatedAt: thread.updatedAt,
    },
    output,
    outputTruncated,
  };
}

function serializeResult(thread, output) {
  if (output === null) {
    const serialized = JSON.stringify(resultPayload(thread, null, false), null, 2);
    if (Buffer.byteLength(serialized, "utf8") > THREAD_RESULT_LIMIT_BYTES) {
      deny("target thread metadata exceeds the result limit");
    }
    return serialized;
  }

  const characters = [];
  let complete = true;
  for (const character of output) {
    if (characters.length === THREAD_RESULT_LIMIT_BYTES) {
      complete = false;
      break;
    }
    characters.push(character);
  }

  if (complete) {
    const serialized = JSON.stringify(resultPayload(thread, output, false), null, 2);
    if (Buffer.byteLength(serialized, "utf8") <= THREAD_RESULT_LIMIT_BYTES) {
      return serialized;
    }
  }

  let low = 0;
  let high = characters.length;
  let accepted = null;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const prefix = characters.slice(0, middle).join("");
    const serialized = JSON.stringify(
      resultPayload(thread, prefix, !complete || middle < characters.length),
      null,
      2,
    );
    if (Buffer.byteLength(serialized, "utf8") <= THREAD_RESULT_LIMIT_BYTES) {
      accepted = serialized;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (accepted === null) {
    deny("target thread metadata exceeds the result limit");
  }
  return accepted;
}

export async function readProjectThread(policy, sdk, params) {
  const threadId = parseThreadId(params);
  let thread;
  try {
    thread = await sdk.threads.get({ threadId });
  } catch {
    deny("target thread is not an authorized visible project thread");
  }
  if (
    !thread ||
    thread.projectId !== policy.projectId ||
    thread.visibility !== "visible"
  ) {
    deny("target thread is not an authorized visible project thread");
  }

  const response = await sdk.threads.output({ threadId });
  if (
    !response ||
    (response.output !== null && typeof response.output !== "string")
  ) {
    deny("target thread returned an invalid output response");
  }

  return serializeResult(thread, response.output);
}

export const threadReadLimits = Object.freeze({
  resultBytes: THREAD_RESULT_LIMIT_BYTES,
});
