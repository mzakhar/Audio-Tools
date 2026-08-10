#!/usr/bin/env sh
# Trigger a Synth rollout on themachine.
#
# Flux reconciles deploy/k8s and is not the problem: it tracks main correctly.
# The gap is that deploy/k8s/deployment.yaml pins the *moving* tag
# ghcr.io/mzakhar/audio-tools:main. A merge that touches no manifest leaves the
# Deployment spec byte-identical, so Flux applies the same YAML, Kubernetes sees
# no change, and no new pod is created — the running container keeps serving the
# old image from behind the same tag. imagePullPolicy: Always only takes effect
# when a pod is created, and nothing creates one.
#
# This cluster runs only the helm/kustomize/notification/source controllers, so
# there is no image-reflector or image-automation controller to notice that the
# tag moved. Until there is, the rollout has to be asked for.
#
# ponytail: a restart, not real GitOps — nothing records which build is live.
# The proper fix is to pin the immutable sha-<commit> tag and let CI commit the
# bump, so Flux has genuine drift to reconcile. Worth doing if deploys ever need
# to be auditable, or to happen without a human running this.
set -eu

HOST="${SYNTH_HOST:-mzakhar@themachine}"

# Restarting onto an image that has not finished publishing is the exact
# "my change isn't there" confusion this script exists to fix, so check first.
# Skipped without gh, or with SKIP_IMAGE_CHECK=1.
if [ "${SKIP_IMAGE_CHECK:-0}" != "1" ] && command -v gh >/dev/null 2>&1; then
  sha=$(git rev-parse origin/main)
  status=$(gh run list --workflow publish-image.yml --limit 20 \
    --json headSha,conclusion --jq "map(select(.headSha==\"$sha\")) | .[0].conclusion" 2>/dev/null || echo '')
  case "$status" in
    success) echo "image published for ${sha%"${sha#???????}"}" ;;
    '' | null) echo "WARNING: no completed publish-image run for $sha — the pod may come back on an older image" ;;
    *) echo "WARNING: publish-image for $sha concluded '$status' — the pod may come back on an older image" ;;
  esac
fi

ssh "$HOST" '
  set -eu
  kubectl -n synth rollout restart deployment/synth
  kubectl -n synth rollout status deployment/synth --timeout=120s
  kubectl -n synth get pods -o wide
'
