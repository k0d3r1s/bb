const DESKTOP_RELEASE_CHANNEL_ENV_NAME = "BB_DESKTOP_RELEASE_CHANNEL";
const DESKTOP_LOCAL_BUILD_ENV_NAME = "BB_DESKTOP_LOCAL_BUILD";

function resolveDesktopBuildSetting(env, args) {
  const rawValue = env[args.name]?.trim();
  if (rawValue === undefined || rawValue.length === 0) {
    return args.defaultValue;
  }
  if (args.allowedValues.includes(rawValue)) {
    return rawValue;
  }

  throw new Error(
    `${args.name} must be ${args.allowedValues.join(" or ")}, got ${rawValue}.`,
  );
}

export function resolveDesktopBuildSettings(env) {
  return {
    localBuild:
      resolveDesktopBuildSetting(env, {
        allowedValues: ["0", "1"],
        defaultValue: "0",
        name: DESKTOP_LOCAL_BUILD_ENV_NAME,
      }) === "1",
    releaseChannel: resolveDesktopBuildSetting(env, {
      allowedValues: ["latest", "nightly"],
      defaultValue: "latest",
      name: DESKTOP_RELEASE_CHANNEL_ENV_NAME,
    }),
  };
}

export function resolveDesktopBuildPlatform(nodePlatform) {
  if (nodePlatform === "darwin") {
    return "macos";
  }
  if (nodePlatform === "linux") {
    return "linux";
  }

  throw new Error(
    `Desktop builds support darwin and linux only, got ${nodePlatform}.`,
  );
}

export function createDesktopReleaseConfig(channel, localBuild = false) {
  if (localBuild) {
    return {
      appId: "dev.bb.desktop.local",
      applicationName: "bb Local",
      macBundleDisplayName: "bb",
      artifactName: "bb-local-${version}-${arch}.${ext}",
      iconFileName: "icon.png",
      linuxExecutableName: "bb-local",
      macIconPath: "assets/icon.icns",
      releaseTag: "desktop-latest",
      updateMetadataFileNames: {
        linux: "latest-linux.yml",
        macos: "latest-mac.yml",
      },
    };
  }

  if (channel === "nightly") {
    return {
      appId: "dev.bb.desktop.nightly",
      applicationName: "bb Nightly",
      artifactName: "bb-nightly-${version}-${arch}.${ext}",
      iconFileName: "icon-nightly.png",
      // The Linux binary name must differ from stable so both channels can be
      // installed at once without one shadowing the other on PATH.
      linuxExecutableName: "bb-nightly",
      macIconPath: "assets/icon-nightly.icns",
      releaseTag: "desktop-nightly",
      updateMetadataFileNames: {
        linux: "nightly-linux.yml",
        macos: "nightly-mac.yml",
      },
    };
  }

  return {
    appId: "dev.bb.desktop",
    applicationName: "bb",
    artifactName: "${productName}-${version}-${arch}.${ext}",
    iconFileName: "icon.png",
    linuxExecutableName: "bb",
    macIconPath: "assets/icon.icns",
    releaseTag: "desktop-latest",
    updateMetadataFileNames: {
      linux: "latest-linux.yml",
      macos: "latest-mac.yml",
    },
  };
}

export function createDesktopUpdateReleaseBaseUrl(releaseTag) {
  return `https://github.com/get-bb/bb/releases/download/${releaseTag}/`;
}
