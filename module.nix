{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.scrape-procon;
  stateDir = "/var/lib/scrape-procon";
in
{
  options.services.scrape-procon = {
    enable = lib.mkEnableOption "Zelda restock watcher";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      description = "The scrape-procon package to run.";
    };

    settings = lib.mkOption {
      type = (pkgs.formats.yaml { }).type;
      description = ''
        Contents of config.yaml. Ntfy topic, interval, jitter, stores.
        See upstream config.yaml for the shape.
      '';
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/etc/nixos/secrets/scrape-procon.env";
      description = ''
        Env file containing CLOAKBROWSER_LICENSE_KEY=...
        Required for Best Buy (Pro binary); the free binary is TLS-rejected.
      '';
    };

    windowsFonts = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/etc/nixos/windows-fonts";
      description = ''
        Directory of Windows .ttf files (segoeui*, tahoma*, verdana*, arial*).
        Required for the Walmart fingerprint (fingerprint: windows).
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # Non-free cloakbrowser binary cache dir must be writable, not the store.
    systemd.services.scrape-procon = {
      description = "Zelda restock watcher";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = {
        SCRAPE_PROCON_CACHE_DIR = "${stateDir}/cloakbrowser-cache";
        HOME = stateDir;
      }
      // (lib.optionalAttrs (cfg.windowsFonts != null) {
        SCRAPE_PROCON_WIN_FONTS = cfg.windowsFonts;
      });

      serviceConfig = {
        Type = "simple";
        ExecStart = "${cfg.package}/bin/watch";
        EnvironmentFile = lib.mkIf (cfg.environmentFile != null) [ cfg.environmentFile ];
        StateDirectory = "scrape-procon";
        WorkingDirectory = stateDir;
        Restart = "always";
        RestartSec = 15;
        DynamicUser = true;
        NoNewPrivileges = true;
        PrivateTmp = true;
      };
    };

    environment.etc."scrape-procon/config.yaml".source =
      (pkgs.formats.yaml { }).generate "config.yaml" cfg.settings;
  };
}
