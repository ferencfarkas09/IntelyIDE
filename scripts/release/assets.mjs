// The file names of one release, in one place: pack-release.mjs, stage-artifacts.mjs, the release workflow and release.sh agree on them.
// Offline, no dependency.

/** What Tauri writes per bundle type, and where, relative to <target>/release/bundle (or <target>/<triple>/release/bundle). */
export const CI_BUNDLES = {
  linux: [
    { kind: "appimage", dir: "appimage", match: /\.AppImage$/ },
    { kind: "deb", dir: "deb", match: /\.deb$/ },
  ],
  windows: [
    { kind: "nsis", dir: "nsis", match: /-setup\.exe$/ },
    { kind: "msi", dir: "msi", match: /\.msi$/ },
  ],
};

/** The released file names of a version. `sbom` describes the sources and dependencies, not one platform. */
export function assetNames(version) {
  return {
    dmg: `IntelyIDE_${version}_universal.dmg`,
    appimage: `IntelyIDE_${version}_x86_64.AppImage`,
    deb: `intelyide_${version}_amd64.deb`,
    nsis: `IntelyIDE_${version}_x64-setup.exe`,
    msi: `IntelyIDE_${version}_x64.msi`,
    sbom: `IntelyIDE_${version}.sbom.cdx.json`,
  };
}

/** The kinds the GitHub Actions workflow builds, by platform. */
export const CI_KINDS = { linux: ["appimage", "deb"], windows: ["nsis", "msi"] };
export const ALL_CI_KINDS = [...CI_KINDS.windows, ...CI_KINDS.linux];

/** The platform a built-in kind belongs to. */
export const platformOf = (kind) => (kind === "dmg" ? "mac" : CI_KINDS.windows.includes(kind) ? "windows" : "linux");

/** A file size within the range a real build of that kind can have (a truncated or empty download fails). */
export const MIN_BYTES = { dmg: 5e6, appimage: 5e6, deb: 2e6, nsis: 2e6, msi: 2e6 };
