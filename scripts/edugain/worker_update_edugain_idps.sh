#!/bin/bash
SCRIPTPATH="$( cd "$(dirname "$0")" >/dev/null 2>&1 ; pwd -P )"

curl --fail --silent https://technical.edugain.org/api.php?action=list_entities -H "Accept: application/json" --output "${SCRIPTPATH}/edugain_idps.json"

# Update edugain IDPs local database table (edugain_idps)
cd "${SCRIPTPATH}/../../"
poetry run python "${SCRIPTPATH}/worker_update_edugain_idps.py" &>> "${SCRIPTPATH}/worker_update_edugain_idps.log"

