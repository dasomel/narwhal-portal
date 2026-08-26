# Cosign image signing — one-time human setup (narwhal#35)

`.github/workflows/docker-publish.yml`'s `sign` job signs every image this repo publishes so
narwhal's Kyverno `verify-image-signatures` ClusterPolicy and its air-gap preflight gate
(`scripts/airgap/10-verify-image-signatures.sh`) can verify them. Both consume a **static Cosign
key pair** — not Sigstore keyless/Fulcio/Rekor — because narwhal's cluster is air-gapped and must
verify without reaching the public Rekor transparency log (see narwhal's
`docs/common/supply-chain-policy.md` §6 for the design decision).

The workflow only *references* the key material via GitHub Actions secrets; nothing in this repo
generates or stores a real key. This doc is the exact procedure a human runs once to provision it.

## 1. Generate the key pair

Run this locally, **not** in CI — the private key must never touch a CI log or artifact.

```bash
cosign generate-key-pair
```

This prompts for a password and writes two files to the current directory:

- `cosign.key` — the password-encrypted private key. **Never commit this. Never paste it
  anywhere but the secret command below.**
- `cosign.pub` — the public key. Not sensitive; this repo commits it (see step 4).

If you need a non-interactive password (e.g. scripting the whole setup in one go), export
`COSIGN_PASSWORD` first — `cosign generate-key-pair` reads it instead of prompting:

```bash
export COSIGN_PASSWORD='<a strong password, from a password manager, not this shell history>'
cosign generate-key-pair
```

## 2. Create the two GitHub Actions secrets

The `sign` job reads exactly these two secret names — they must match exactly:

```bash
gh secret set COSIGN_PRIVATE_KEY --repo dasomel/narwhal-portal < cosign.key
gh secret set COSIGN_PASSWORD --repo dasomel/narwhal-portal
# ^ paste the same password used in step 1 when prompted (or pipe it: echo "$COSIGN_PASSWORD" | gh secret set COSIGN_PASSWORD --repo dasomel/narwhal-portal)
```

Both are required. `cosign.key` from `generate-key-pair` is password-encrypted by default, and
`cosign sign` only decrypts it non-interactively when `COSIGN_PASSWORD` is set in the
environment — without it, the signing step would block on a stdin prompt that doesn't exist on a
GitHub Actions runner. The `sign` job checks for both before attempting to sign, and **fails the
workflow outright** if either is missing on a real `v*.*.*` release tag (it only warns-and-skips
on an ad-hoc `workflow_dispatch` build).

## 3. Delete the private key locally

```bash
rm -f cosign.key
```

Nothing else needs it once the secret is set. If you used a shell with history, also scrub
`COSIGN_PASSWORD` from your shell history / unset it from the session.

## 4. Commit the public key to this repo

Commit `cosign.pub` at this repo's root:

```bash
git add cosign.pub
git commit -m "chore(security): add cosign public key for narwhal#35 image signing"
```

**Why the repo root, and why committed here rather than fetched cross-repo at verify time:**
narwhal's whole air-gap design principle is that verification never depends on a live network
call (that's the entire reason it's static-key instead of keyless/Rekor). A public key fetched
over the network at admission or preflight time would violate that same principle just one layer
down. So the key has to become a **versioned file narwhal already has offline**, not something
either side fetches live.

`narwhal-portal` is the natural place to *mint* the key pair (it's the repo that signs), but
`narwhal` is the repo that actually consumes it at two call sites, in two different shapes:

- `gitops/resources/kyverno-policies.yaml`'s `verify-image-signatures` ClusterPolicy needs the
  PEM **inlined** as the `attestors[].entries[].keys.publickeys` value (Kyverno's schema takes key
  material inline, not a file path) — currently a placeholder value. Copy `cosign.pub`'s contents
  into both `publickeys:` blocks in that file (signature attestor and SBOM attestor).
- `scripts/airgap/10-verify-image-signatures.sh` takes a `--key KEY_FILE` **file path** into the
  air-gap bundle. The recommended convention: copy `narwhal-portal/cosign.pub` to
  `narwhal/scripts/airgap/keys/cosign.pub` (new path — doesn't exist yet) and pass
  `--key scripts/airgap/keys/cosign.pub`, so the bundle carries the key offline like every other
  air-gap artifact.

Both are **manual copy-and-commit** steps on the narwhal side, done once per key rotation, not
automated cross-repo fetches — consistent with narwhal's existing pinned-artifact conventions
(binary checksums, commit-pinned Actions) where nothing is pulled live at verify time. That change
belongs to narwhal's own harness; this repo only publishes `cosign.pub` for narwhal to pick up.

## 5. Verify

After the secrets are set, push a `v*.*.*` tag (or re-run the workflow via `workflow_dispatch` to
sanity-check the non-mandatory path) and confirm the `sign` job's "Sign image digest" step
succeeds. To manually verify a signed image once `cosign.pub` is committed:

```bash
cosign verify --key cosign.pub ghcr.io/dasomel/narwhal-portal@sha256:<digest>
```

## Key rotation

Repeat steps 1–4 with a new key pair, update both `publickeys:` blocks in narwhal's
`kyverno-policies.yaml` and the copied `scripts/airgap/keys/cosign.pub`, and overwrite the two
GitHub secrets (`gh secret set` on an existing name replaces it). Old signatures made with the
retired key stop verifying the moment narwhal's key is swapped — there is no overlap window in
this design, so coordinate the narwhal-side update to land before or alongside the secret swap.
