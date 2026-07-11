#!/usr/bin/env sh
set -eu

APP_DIR="${APP_DIR:-$HOME/apps/synth}"
REPO_URL="${REPO_URL:-https://github.com/mzakhar/Audio-Tools.git}"
BRANCH="${BRANCH:-main}"

if [ ! -d "$APP_DIR/.git" ]; then
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"

kubectl apply -k deploy/k8s
kubectl -n synth rollout restart deployment/synth
kubectl -n synth rollout status deployment/synth --timeout=120s
