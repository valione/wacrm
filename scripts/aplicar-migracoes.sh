#!/usr/bin/env bash
# Aplica um intervalo de migrações num banco de instalação, em ordem, cada uma
# na sua própria transação, e registra em supabase_migrations.schema_migrations.
# Para no primeiro erro. Migração já registrada é pulada.
#
# Uso: scripts/aplicar-migracoes.sh "<connection string URI>" 045 050
set -euo pipefail

URI="${1:?informe a connection string}"
FIRST="${2:?informe a primeira migração (ex.: 045)}"
LAST="${3:?informe a última migração (ex.: 050)}"
PSQL="${PSQL:-/opt/homebrew/opt/libpq/bin/psql}"
DIR="$(cd "$(dirname "$0")/../supabase/migrations" && pwd)"

for f in "$DIR"/*.sql; do
  name="$(basename "$f" .sql)"
  version="${name%%_*}"
  [[ "$version" < "$FIRST" || "$version" > "$LAST" ]] && continue

  applied="$("$PSQL" "$URI" -tA -c "SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '$version'")"
  if [[ "$applied" == "1" ]]; then
    echo "$name: já registrada, pulando"
    continue
  fi

  echo "$name: aplicando..."
  "$PSQL" "$URI" -q -v ON_ERROR_STOP=1 --single-transaction -f "$f"
  "$PSQL" "$URI" -q -v ON_ERROR_STOP=1 -c \
    "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('$version', '$name')"
  echo "$name: OK"
done

echo "MIGRAÇÕES $FIRST-$LAST CONCLUÍDAS"
