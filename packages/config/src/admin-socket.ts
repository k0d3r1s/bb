import { basename, dirname, join, resolve } from "node:path";

export interface AdminSocketPaths {
  directoryPath: string;
  socketPath: string;
  capabilityPath: string;
}

export function resolveAdminSocketPaths(dataDir: string): AdminSocketPaths {
  const directoryPath = join(resolve(dataDir), "admin");
  return {
    directoryPath,
    socketPath: join(directoryPath, "maintenance.sock"),
    capabilityPath: join(directoryPath, "capability"),
  };
}

const unixSocketPathByteLimit = process.platform === "darwin" ? 104 : 108;

export function withUnixSocketAddress<T>(
  socketPath: string,
  use: (address: string) => T,
): T {
  if (Buffer.byteLength(socketPath) < unixSocketPathByteLimit) {
    return use(socketPath);
  }
  const previousCwd = process.cwd();
  process.chdir(dirname(socketPath));
  try {
    return use(basename(socketPath));
  } finally {
    process.chdir(previousCwd);
  }
}
