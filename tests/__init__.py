__version__ = '0.9.0'


from gettext import NullTranslations
trans = NullTranslations()
del NullTranslations


_exact_version = __version__


def exact_version():
    return _exact_version
