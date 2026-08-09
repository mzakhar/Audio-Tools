# Home Lab Deployment Plan

## Target

- Host: `themachine` (`192.168.1.3`)
- Platform: k3s with Traefik
- LAN URL: `http://192.168.1.3/synth/`
- GitHub repo: `mzakhar/Audio-Tools`
- Container image: `ghcr.io/mzakhar/audio-tools:main`

## Model

1. GitHub Actions builds and publishes the renderer container to GHCR on every push to `main`.
2. `themachine` runs a systemd timer that pulls the repo from GitHub every five minutes.
3. The deploy script applies `deploy/k8s` with `kubectl apply -k`.
4. The deployment uses `imagePullPolicy: Always` and restarts the single replica so k3s pulls the newest `main` image.
5. Traefik serves the app at `/synth/` and strips the prefix before forwarding to nginx.

## One-Time Server Setup

On `themachine`:

```sh
mkdir -p ~/apps
git clone https://github.com/mzakhar/Audio-Tools.git ~/apps/synth
cd ~/apps/synth
kubectl apply -k deploy/k8s
mkdir -p ~/.config/systemd/user
cp deploy/systemd/synth-deploy.* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now synth-deploy.timer
```

If GHCR package visibility is private, create a Kubernetes image pull secret in the `synth` namespace and add it to `deploy/k8s/deployment.yaml`.

## Repo Changes

- `Dockerfile` builds `npm run build` and serves `out/renderer` from nginx.
- `electron.vite.config.js` uses relative renderer assets so the same build works under `/synth/` and Electron `loadFile`.
- `.github/workflows/container.yml` publishes GHCR images for `main`, tags, and commit SHAs.
- `deploy/k8s` defines namespace, deployment, service, Traefik ingress, and kustomization.
- `scripts/deploy-k3s.sh` implements the pull/apply/restart flow used by the systemd timer.

## Follow-Ups

- Move from mutable `:main` to immutable SHA tags plus Flux image automation when you want stronger rollout auditability.
- Add external routing through `zakharhome.org` after Cloudflare exposure is ready.
- Decide whether browser-hosted Synth should hide Electron-only file controls until File System Access API support is complete.
