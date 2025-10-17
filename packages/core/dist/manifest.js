import { M } from "./chunks/manifest-generator-Bb3IuFsV.js";
import { staticManifest } from "./chunks/static-manifest-BPFs-FaZ.js";
function getManifest() {
  return import("./chunks/static-manifest-BPFs-FaZ.js").then((m) => m.staticManifest);
}
export {
  M as ManifestGenerator,
  getManifest,
  staticManifest as manifest
};
//# sourceMappingURL=manifest.js.map
