#!/usr/bin/env bash
# Local, project-scoped Postgres cluster (does not touch any system database).
set -euo pipefail
cd "$(dirname "$0")/.."
PGDATA="$PWD/.pgdata"
PORT="${PGPORT_LOCAL:-54329}"
case "${1:-}" in
  init)
    if [ -f "$PGDATA/PG_VERSION" ]; then echo "already initialised: $PGDATA"; exit 0; fi
    initdb -D "$PGDATA" -U nazariya --auth=trust -E UTF8 --locale=C >/dev/null
    echo "initialised $PGDATA"
    ;;
  start)
    if pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then echo "already running on $PORT"; else
      pg_ctl -D "$PGDATA" -l "$PGDATA/server.log" -w \
        -o "-p $PORT -k $PGDATA -c listen_addresses=localhost -c fsync=off -c max_connections=60" start >/dev/null
      echo "started on localhost:$PORT"
    fi
    for db in nazariya nazariya_test; do
      psql -h localhost -p "$PORT" -U nazariya -d postgres -tAc "select 1 from pg_database where datname='$db'" | grep -q 1 \
        || createdb -h localhost -p "$PORT" -U nazariya "$db"
    done
    ;;
  stop) pg_ctl -D "$PGDATA" stop -m fast ;;
  status) pg_ctl -D "$PGDATA" status ;;
  psql) shift; psql -h localhost -p "$PORT" -U nazariya -d "${1:-nazariya}" ;;
  *) echo "usage: db.sh init|start|stop|status|psql [db]"; exit 1 ;;
esac
