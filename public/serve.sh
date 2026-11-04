#!/bin/sh
# FlexiPath: serve the built site over HTTP (D-02). Run it from the folder that holds index.html (dist/):
#   sh serve.sh [port]        then open http://localhost:8000/ (guided demo: /simulator.html?demo=1)
cd "$(dirname "$0")" && exec python3 -m http.server "${1:-8000}" --bind 127.0.0.1
