# imports
import json
import datetime
import os

from taguette import database
from taguette.database.models import EdugainIdps

dir_path = os.path.dirname(os.path.realpath(__file__))
conf_path = os.path.dirname(os.path.dirname(dir_path))

# Open edugain idps JSON file
json_file = f'{dir_path}/edugain_idps.json'
try:
    f = open(json_file)
    idps = json.load(f)
except:
    print(f"{json_file} not found")
    exit()

config = {}
config_file = os.path.abspath(f'{conf_path}/taguette.conf')
with open(config_file) as fp:
    code = compile(fp.read(), config_file, 'exec')
exec(code, config)
DBSession = database.connect(config['DATABASE'])
db = DBSession()

idps_added = 0
idps_removed = 0
idps_updated = 0

if idps[0][0]['id'] is not None:

    for idp in idps:
        idp_id = db.query(database.EdugainIdps).get(idp[0]['id'])

        if idp_id is None:
            # Add a new entry
            new_idp = EdugainIdps()
            new_idp.id = idp[0]['id']
            new_idp.entityid = idp[0]['entityid']
            new_idp.e_displayname = idp[0]['e_displayname']
            new_idp.regauth = idp[0]['regauth']
            new_idp.entity_cat = idp[0]['entity_cat']
            new_idp.eccs_status = idp[0]['eccs_status']
            new_idp.validator_status = idp[0]['validator_status']
            new_idp.coco_status = idp[0]['coco_status']
            new_idp.coco_id = idp[0]['coco_id']
            new_idp.sirtfi_status = idp[0]['sirtfi_status']
            new_idp.code = idp[0]['code']
            new_idp.scopes = idp[0]['scopes']

            db.add(new_idp)
            db.commit()

            idps_added += 1

        else:
            # Update existing entry
            idp_id.entityid = idp[0]['entityid']
            idp_id.e_displayname = idp[0]['e_displayname']
            idp_id.regauth = idp[0]['regauth']
            idp_id.entity_cat = idp[0]['entity_cat']
            idp_id.eccs_status = idp[0]['eccs_status']
            idp_id.validator_status = idp[0]['validator_status']
            idp_id.coco_status = idp[0]['coco_status']
            idp_id.coco_id = idp[0]['coco_id']
            idp_id.sirtfi_status = idp[0]['sirtfi_status']
            idp_id.code = idp[0]['code']
            idp_id.scopes = idp[0]['scopes']
            db.commit()


if idps_added != 0 or idps_removed != 0 or idps_updated != 0:

    ct = "["+str(datetime.datetime.now())+"]"
    print( ct+" UPDATE EDUGAIN IDPs => IDPs added: {0} ".format(idps_added) )

# Close File
f.close()