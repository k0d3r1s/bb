export type DesktopReleaseChannel = "latest" | "nightly";
export type DesktopBuildPlatform = "macos" | "linux";

export interface DesktopUpdateMetadataFileNames {
  linux: "latest-linux.yml" | "nightly-linux.yml";
  macos: "latest-mac.yml" | "nightly-mac.yml";
}

export interface DesktopReleaseConfig {
  appId: "dev.bb.desktop" | "dev.bb.desktop.nightly" | "dev.bb.desktop.local";
  applicationName: "bb" | "bb Nightly" | "bb Local";
  artifactName: string;
  iconFileName: "icon.png" | "icon-nightly.png";
  linuxExecutableName: "bb" | "bb-nightly" | "bb-local";
  macIconPath: "assets/icon.icns" | "assets/icon-nightly.icns";
  releaseTag: "desktop-latest" | "desktop-nightly";
  updateMetadataFileNames: DesktopUpdateMetadataFileNames;
}

export function resolveDesktopBuildSettings(env: NodeJS.ProcessEnv): {
  localBuild: boolean;
  releaseChannel: DesktopReleaseChannel;
};

export function resolveDesktopBuildPlatform(
  nodePlatform: string,
): DesktopBuildPlatform;

export function createDesktopReleaseConfig(
  channel: DesktopReleaseChannel,
  localBuild?: boolean,
): DesktopReleaseConfig;

export function createDesktopUpdateReleaseBaseUrl(
  releaseTag: DesktopReleaseConfig["releaseTag"],
): string;
