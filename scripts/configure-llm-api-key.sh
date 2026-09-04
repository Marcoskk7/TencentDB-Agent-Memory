#!/usr/bin/env bash
# Configure one upstream LLM API key for both local worktrees.
#
# Usage:
#   ./scripts/configure-llm-api-key.sh
#   ./scripts/configure-llm-api-key.sh --dry-run

set -euo pipefail

if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=true
elif [[ $# -eq 0 ]]; then
  dry_run=false
else
  echo "Usage: $0 [--dry-run]" >&2
  exit 2
fi

script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
evidence_root="$(cd -- "$script_dir/.." && pwd)"
primary_root="$(cd -- "$evidence_root/../TencentDB-Agent-Memory" 2>/dev/null && pwd || true)"

roots=("$evidence_root")
if [[ -n "$primary_root" && "$primary_root" != "$evidence_root" ]]; then
  roots+=("$primary_root")
fi

printf 'Upstream LLM API key (input hidden): '
IFS= read -r -s api_key
printf '\n'

if [[ -z "$api_key" ]]; then
  echo "API key cannot be empty." >&2
  exit 1
fi

# The proxy config is written as a double-quoted YAML scalar.
if [[ "$api_key" == *'"'* || "$api_key" == *\\* ]]; then
  echo 'API key cannot contain a double quote or backslash.' >&2
  exit 1
fi

replace_env_value() {
  local file="$1"
  local name="$2"

  if ! grep -q "^${name}=" "$file"; then
    echo "Missing ${name} in ${file}" >&2
    return 1
  fi

  if [[ "$dry_run" == true ]]; then
    printf 'Would update %s (%s)\n' "$file" "$name"
    return
  fi

  TDAI_LLM_KEY="$api_key" perl -i -pe \
    "s/^\\Q${name}\\E=.*/${name}=\$ENV{TDAI_LLM_KEY}/" "$file"
  printf 'Updated %s (%s)\n' "$file" "$name"
}

replace_proxy_upstream_key() {
  local file="$1"

  if [[ "$dry_run" == true ]]; then
    printf 'Would update %s (upstream.apiKey)\n' "$file"
    return
  fi

  TDAI_LLM_KEY="$api_key" perl -i -pe '
    BEGIN { $key = $ENV{TDAI_LLM_KEY}; $inside_upstream = 0; $replaced = 0; }
    $inside_upstream = 0 if $inside_upstream && /^\S/ && !/^upstream:\s*$/;
    $inside_upstream = 1 if /^upstream:\s*$/;
    if ($inside_upstream && !$replaced && /^(\s+apiKey:\s*).*(\n?)$/) {
      $_ = $1 . q{"} . $key . q{"} . $2;
      $replaced = 1;
    }
    END { die "upstream.apiKey not found\n" unless $replaced; }
  ' "$file"
  printf 'Updated %s (upstream.apiKey)\n' "$file"
}

for root in "${roots[@]}"; do
  env_file="$root/deploy/global-images/.env"
  proxy_config="$root/MemoryProxy/config.yaml"
  knowledge_env="$root/MemoryKnowledge/.env"

  [[ -f "$env_file" ]] || { echo "Missing $env_file" >&2; exit 1; }
  [[ -f "$proxy_config" ]] || { echo "Missing $proxy_config" >&2; exit 1; }

  replace_env_value "$env_file" "MEMORY_LLM_API_KEY"
  replace_env_value "$env_file" "PROXY_UPSTREAM_API_KEY"
  replace_proxy_upstream_key "$proxy_config"

  # This file only exists when MemoryKnowledge is run directly in custom mode.
  if [[ -f "$knowledge_env" ]] && grep -q '^LLM_API_KEY=' "$knowledge_env"; then
    replace_env_value "$knowledge_env" "LLM_API_KEY"
  fi
done

if [[ "$dry_run" == true ]]; then
  echo "Dry run complete; no files changed."
else
  echo "Done. Restart the relevant services for the new key to take effect."
  echo "For direct MemoryCore startup, also export TDAI_LLM_API_KEY in that shell."
fi
