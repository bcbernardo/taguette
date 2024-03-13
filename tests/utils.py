import functools
import itertools
import tempfile
from xml.etree import ElementTree


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
