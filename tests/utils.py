import functools
import itertools
import tempfile
from xml.etree import ElementTree
import json

DEFAULT_COLOR = '#000000'


def _compare_xml(e1, e2):
    assert e1.tag == e2.tag
    assert e1.attrib == e2.attrib
    for c1, c2 in itertools.zip_longest(e1, e2):
        assert c1 is not None and c2 is not None
        _compare_xml(c1, c2)


def compare_xml(str1, str2):
    et1 = ElementTree.fromstring(str1)
    et2 = ElementTree.fromstring(str2)
    _compare_xml(et1, et2)


def with_tempdir(func):
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        with tempfile.TemporaryDirectory() as tmp:
            return func(*args, **kwargs, tmp=tmp)

    return wrapper


def generate_initial_state_script(user_login,
                                  project_id,
                                  version,
                                  documents,
                                  tags,
                                  members,
                                  last_event,
                                  is_demo='false',
                                  demo_highlights_location='[[],[],[]]',
                                  collections=None):

    documents_json = json.dumps(documents)
    tags_json = json.dumps(tags, sort_keys=True)
    members_json = json.dumps(members)
    collections_json = json.dumps(collections if collections is not None else [], sort_keys=True)

    return (
        f'<script type="text/javascript">\n'
        f'    const user_login = "{user_login}";\n'
        f'    const project_id = {project_id};\n'
        f'    const version = \'{version}\';\n'
        f'    let documents = {documents_json};\n'
        f'    let tags = {tags_json};\n'
        f'    let members = {members_json};\n'
        f'    let highlights = {{}};\n'
        f'    let last_event = {last_event};\n'
        f'    let is_demo = {is_demo};\n'
        f'    let demo_highlights_location = {demo_highlights_location};\n'
        f'    let collections = {collections_json};\n'
        f'</script>'
    )


def build_tag_pool_response(pool_id,
                            tag_id,
                            path,
                            parent_id=None,
                            color=DEFAULT_COLOR,
                            description=''):
    return {
        'type': 'tag_add',
        'id': pool_id,
        'tag_id': tag_id,
        'tag_parent': parent_id,
        'tag_color': color,
        'tag_path': path,
        'description': description
    }


def build_tag_response(tag_id,
                       path,
                       description,
                       color=DEFAULT_COLOR,
                       parent=None,
                       children=None):
    return {
        "id": tag_id,
        "path": path,
        "description": description,
        "color": color,
        "parent": parent,
        "count": 0,
        "count_document": 0,
        "children": children if children is not None else []
    }


def build_tag_data(path,
                   parent_id=None,
                   color=DEFAULT_COLOR,
                   description=""):
    return {
        "path": path,
        "parent_id": parent_id,
        "color": color,
        "description": description
    }


def build_collection_pool_response(pool_id,
                                   collection_id,
                                   collection_name,
                                   description='',
                                   parent_id=None,
                                   document_ids=None):
    return {
        'type': 'collection_add',
        'id': pool_id,
        'collection_id': collection_id,
        'collection_name': collection_name,
        'description': description,
        'parent_id': parent_id,
        'document_ids': document_ids if document_ids is not None else []
    }


def build_collection_response(collection_id,
                              name,
                              description='',
                              parent_id=None,
                              document_ids=None,
                              children=None):
    return {
        "id": collection_id,
        "name": name,
        "description": description,
        "parent": parent_id,
        "document_ids": document_ids if document_ids is not None else [],
        "children": children if children is not None else []
    }


def build_collection_data(name,
                          description='',
                          parent_id=None):
    return {
        "name": name,
        "description": description,
        "parent_id": parent_id
    }
