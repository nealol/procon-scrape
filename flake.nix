{
  description = "Zelda restock watcher — cloakbrowser + ntfy push notifications";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self
    , nixpkgs
    , flake-utils
    ,
    }:
    {
      nixosModules.default = import ./module.nix;

      overlays.default = final: prev: {
        scrape-procon = final.callPackage ./package.nix { };
      };
    }
    // flake-utils.lib.eachDefaultSystem (system:
      let pkgs = nixpkgs.legacyPackages.${system};
      in {
        packages.default = pkgs.callPackage ./package.nix { };
        packages.scrape-procon = pkgs.callPackage ./package.nix { };

        devShells.default = pkgs.mkShell {
          packages = [ pkgs.nodejs pkgs.bun ];
        };
      });
}
