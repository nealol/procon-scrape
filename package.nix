{
  lib,
  nodejs,
  buildNpmPackage,
  makeWrapper,
}:

buildNpmPackage {
  pname = "scrape-procon";
  version = "0.1.0";

  src = ./.;

  nodejs = nodejs;

  npmDepsHash = "sha256-RZFgUe20NxWzguOIBBh3S2hzq6NyBskLTEPqj745uNw=";

  dontNpmBuild = true;

  nativeBuildInputs = [ makeWrapper ];

  postInstall = ''
    wrapProgram $out/bin/watch \
      --set SCRAPE_PROCON_CONFIG /etc/scrape-procon/config.yaml
  '';

  meta = {
    description = "Restock watcher: cloakbrowser sweeps + ntfy push alerts";
    mainProgram = "watch";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
