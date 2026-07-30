# LPDO APT repository (GitHub Pages)

Lets Linux users install once and then keep up to date with plain
`sudo apt update && sudo apt upgrade` (#216). The `.debs` for each published
release are indexed into a signed APT repository served from GitHub Pages by
`.github/workflows/apt-repo.yml`.

The database lives under `/var/lib/lpdo` and is **not** part of any package, so
upgrades never touch it.

## For users

One-time setup:

```bash
curl -fsSL https://specure.github.io/lpdo/lpdo.gpg \
  | sudo tee /usr/share/keyrings/lpdo.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/lpdo.gpg] https://specure.github.io/lpdo stable main" \
  | sudo tee /etc/apt/sources.list.d/lpdo.list
sudo apt update
sudo apt install lpdo lpdo-server        # GUI + always-on server; lpdo-cli comes as a dependency
```

From then on:

```bash
sudo apt update && sudo apt upgrade
```

Upgrading from a **pre-0.5.0** monolithic `lpdo` (the `/usr/bin/chess-db`
file-conflict, #208/#215) is now handled automatically — `lpdo-cli` declares
`Replaces`/`Conflicts: lpdo (<< 0.5.0)`, so apt removes the old package and takes
over the file instead of erroring.

## For maintainers — one-time setup

1. **Create a signing key** (on a trusted machine):

   ```bash
   gpg --batch --gen-key <<EOF
   Key-Type: RSA
   Key-Length: 4096
   Name-Real: LPDO APT Repository
   Name-Email: apt@specure.com
   Expire-Date: 0
   %no-protection
   EOF
   gpg --list-secret-keys --keyid-format long   # note the key id
   ```

   (`%no-protection` = no passphrase, simplest for CI. If you set one, also add
   the `APT_GPG_PASSPHRASE` secret below.)

2. **Add repository secrets** (Settings → Secrets and variables → Actions):
   - `APT_GPG_PRIVATE_KEY` — the armored private key:
     `gpg --armor --export-secret-keys <KEYID>` (paste the whole block).
   - `APT_GPG_PASSPHRASE` — only if the key has a passphrase.

3. **Enable GitHub Pages**: Settings → Pages → *Deploy from a branch* →
   branch `gh-pages`, folder `/ (root)`. (The `gh-pages` branch is created by the
   first workflow run.)

4. **Seed the repo** from the current release: Actions → *APT repository* → *Run
   workflow* → tag `v0.13.0`. After it succeeds and Pages goes live, the user
   setup above works.

After that it's automatic: every time a release is **published**, the workflow
adds its `.debs` to the pool, rebuilds + re-signs the indexes, and republishes.
Old versions stay in the pool, so `apt` can pin/downgrade if needed.
