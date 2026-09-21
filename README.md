# Zelda restock watcher

Watches 6 product pages with cloakbrowser, sends an ntfy push when one
goes in stock. Tapping the push opens the product page.

## Run locally (macOS/Linux)

    bun install        # or npm install
    node watch.js              # continuous sweeps
    node watch.js --once       # single sweep
    node watch.js --dump 2     # inspect store 2's rendered page (tune selectors)
    node watch.js --test-notify

## Phone setup

1. Install **ntfy** (App Store / Play Store / F-Droid).
2. Subscribe to topic: `stock-zelda-19e54b`
3. In the topic's settings, set priority to **Max** so it alerts on the lock screen.

The topic string is the credential — anyone who knows it can send you
pushes. Don't share it.

## NixOS

This repo is a flake exposing `packages.scrape-procon` and
`nixosModules.default` (options under `services.scrape-procon`).

In your system flake:

    {
      inputs.scrape-procon.url = "git+file:///path/to/scrape-procon";
      # or: github:<you>/scrape-procon

      outputs = { self, nixpkgs, scrape-procon, ... }: {
        nixosConfigurations.mybox = nixpkgs.lib.nixosSystem {
          system = "x86_64-linux";
          modules = [
            scrape-procon.nixosModules.default
            {
              services.scrape-procon = {
                enable = true;
                environmentFile = "/run/secrets/scrape-procon.env";
                windowsFonts = "/run/secrets/windows-fonts";
                settings = {
                  ntfy = {
                    topic = "stock-zelda-19e54b";
                    title_prefix = "IN STOCK";
                  };
                  interval = 30;
                  jitter = 8;
                  stores = import ./stores.nix;  # or inline the whole map
                };
              };
            }
          ];
        };
      };
    }

Options:

- `settings` — full config.yaml contents (ntfy topic, interval, jitter, stores).
- `environmentFile` — env file with `CLOAKBROWSER_LICENSE_KEY=...`.
  Required: the Pro binary is needed for Best Buy; the free one is
  TLS-rejected.
- `windowsFonts` — path to a directory of Windows .ttf files (segoeui*,
  tahoma*, verdana*, arial*). Required for Walmart's
  `fingerprint: windows` store check.

The module runs the service as a DynamicUser with state in
`/var/lib/scrape-procon` (cloakbrowser's binary cache lives there, since
the store is read-only), writes the config to
`/etc/scrape-procon/config.yaml`, and restarts on failure.

To find the current store list, see `config.yaml` in this repo — copy
the `stores` block into `settings.stores` (Nix attrset form).
