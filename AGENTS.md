# Deployment

- Production Synth is GitOps-managed by Flux in `E:\Projects\homelab-fleet`, not by this repository's legacy `deploy/systemd` files.
- After an Audio-Tools merge, wait for `Publish container image` to pass. Get that merge image's digest, then create and merge a `homelab-fleet` PR updating `clusters/themachine/apps/synth.yaml` → `spec.images[0].digest` for `ghcr.io/mzakhar/audio-tools`.
- Flux source polling is 1 minute; Synth reconciliation is 10 minutes. For immediate rollout or verification, use `ssh mzakhar@themachine` only when access is available.
