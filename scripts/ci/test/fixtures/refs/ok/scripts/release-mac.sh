#!/usr/bin/env bash
# fixture orchestrator: only the flags matter to check-refs
case "$1" in
  --arch) ;; --ci) ;; --out) ;; --require-style) ;; --sign) ;; --require-notarized) ;; --hooks-smoke) ;; --dynamic) ;;
  --stage) case "$2" in build | sign | verify) ;; esac ;;
esac
