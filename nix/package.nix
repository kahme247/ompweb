{
  lib,
  stdenv,
  buildNpmPackage,
  autoPatchelfHook,
  ...
}:
let
  productionLib = lib.fileset.difference ../lib (
    lib.fileset.fileFilter (file: lib.hasInfix ".test." file.name) ../lib
  );

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../app
      ../bin
      ../components
      ../hooks
      productionLib
      ../public
      ../scripts

      ../bunfig.toml
      ../instrumentation.node.ts
      ../package.json
      ../package-lock.json
      ../server
      ../tailwind.config.ts
      ../tsconfig.json
      ../proxy.ts
    ];
  };
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
in
buildNpmPackage (finalAttrs: {
  pname = "ompweb";
  inherit src version;

  # Unverified: written without nix. Refresh npmDepsHash on a machine with nix (`nix build .#default` prints it).
  npmDepsHash = "sha256-HxT+m6bI0I3t9sqsSgHun6oXve3WtIEmkFpCoBplrC4=";

  # npmPackFlags = [ "--ignore-scripts" ];

  # Bun runs from the npm @oven/bun-<os>-<arch> package (the pinned version every install uses). bun's postinstall
  # (the only install script) execs that binary before it is patched, so skip it: bin/bun-runtime.js then picks the
  # @oven binary itself.
  npmRebuildFlags = [ "--ignore-scripts" ];
  nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
  # Patched once in preBuild (the build runs it); fixup has nothing else to patch.
  dontAutoPatchelf = true;

  # node_modules/.bin/bun points at bun's postinstall placeholder; build with the binary the launcher resolves.
  preBuild = ''
    ${lib.optionalString stdenv.hostPlatform.isLinux "autoPatchelf -- node_modules/@oven"}
    rm -f node_modules/.bin/bun node_modules/.bin/bunx
    export PATH="$(dirname "$(node -p 'require("./bin/bun-runtime.js").resolveBunBinary(".")')"):$PATH"
  '';

  meta = {
    description = "Local web UI for the oh-my-pi (omp) coding agent";
    license = lib.licenses.mit;
  };
})
