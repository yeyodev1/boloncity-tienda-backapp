#!/bin/bash
#
# Deja SANDBOX con el mismo catálogo que producción y sus llaves al día.
#
# Copia SOLO el catálogo (categorías, productos y settings). NO toca `branches`,
# para no pisar las llaves de Picker de desarrollo que ya tienen las sucursales de
# sandbox, ni `orders`.
#
# Las credenciales se pasan por entorno; no viven en este archivo. Están en
# DEPLOYMENT.md, en la raíz del repo padre.
#
#   PROD_DB_URI='mongodb+srv://...@boloncity-prod...' \
#   DEV_DB_URI='mongodb+srv://...@boloncity-dev...' \
#   PICKER_MASTER_KEY_DEV='...' \
#     bash scripts/sync-sandbox.sh
#
# Diagnóstico rápido si falla la conexión a Mongo:
#   "Could not connect to any servers"  -> falta la IP en Network Access de Atlas
#   "bad auth"                          -> la contraseña está mal
#
set -euo pipefail
cd "$(dirname "$0")/.."

: "${PROD_DB_URI:?Falta PROD_DB_URI}"
: "${DEV_DB_URI:?Falta DEV_DB_URI}"
: "${PICKER_MASTER_KEY_DEV:?Falta PICKER_MASTER_KEY_DEV}"

# Los scripts importan src/config/env.ts, que exige JWT_SECRET aunque no lo usen.
export JWT_SECRET="${JWT_SECRET:-solo-para-scripts}"

echo "=== 1. Catálogo de producción -> sandbox (sin tocar sucursales ni órdenes) ==="
SOURCE_DB_URI="$PROD_DB_URI" TARGET_DB_URI="$DEV_DB_URI" \
  npx ts-node --transpile-only src/scripts/cloneDatabase.ts \
  --collections=categories,products,settings --apply

echo ""
echo "=== 2. Catálogo visible en todas las sucursales de sandbox ==="
DB_URI="$DEV_DB_URI" npx ts-node --transpile-only src/scripts/fixProductBranches.ts --apply

echo ""
echo "=== 3. Llaves de Picker de desarrollo por sucursal ==="
DB_URI="$DEV_DB_URI" PICKER_MASTER_KEY="$PICKER_MASTER_KEY_DEV" \
  PICKER_API_BASE_URL='https://dev-api.pickerexpress.com/api' \
  npx ts-node --transpile-only src/scripts/syncPickerStores.ts --env=development --apply

echo ""
echo "=== 4. Tiendas de PayPhone por sucursal (las mismas que producción) ==="
DB_URI="$DEV_DB_URI" npx ts-node --transpile-only src/scripts/syncPayphoneStores.ts --apply

echo ""
echo "=== 5. Auditoría final de sandbox ==="
DB_URI="$DEV_DB_URI" PICKER_MASTER_KEY="$PICKER_MASTER_KEY_DEV" \
  npx ts-node --transpile-only src/scripts/auditBranches.ts --env=development
